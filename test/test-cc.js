const API_BASE = 'http://localhost:8045';
const API_KEY = 'sk-text';
const DEFAULT_MODEL = 'claude-opus-4-5-thinking';
const RETRY_DELAY = 30000; // 30秒延迟
const MAX_RETRIES = 1; // 最大重试次数

// 延迟函数
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 带重试的 fetch 封装
async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (error) {
      if (i < retries) {
        console.log(`请求失败，${RETRY_DELAY / 1000}秒后重试... (${i + 1}/${retries})`);
        await sleep(RETRY_DELAY);
      } else {
        throw error;
      }
    }
  }
}

// 测试非流式响应
async function testNonStream() {
  console.log('\n=== 测试 Claude API 非流式响应 ===\n');
  
  try {
    const response = await fetchWithRetry(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: '你好，请用一句话介绍你自己'
          }
        ]
      })
    });
    
    const data = await response.json();
    console.log('响应状态:', response.status);
    console.log('响应数据:', JSON.stringify(data, null, 2));
    
    if (response.status === 200 && data.type === 'message') {
      console.log('\n✓ 非流式响应测试通过');
    } else {
      console.log('\n✗ 非流式响应测试失败');
    }
  } catch (error) {
    console.error('✗ 非流式响应测试失败:', error.message);
  }
}

// 测试流式响应
async function testStream() {
  console.log('\n=== 测试 Claude API 流式响应 ===\n');
  
  try {
    const response = await fetchWithRetry(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 4096,
        stream: true,
        messages: [
          {
            role: 'user',
            content: '请数从1到5'
          }
        ]
      })
    });
    
    console.log('响应状态:', response.status);
    console.log('开始接收流式数据:\n');
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventCount = 0;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop(); // 保留最后一行（可能不完整）
      
      for (const line of lines) {
        if (line.trim()) {
          console.log(line);
          eventCount++;
        }
      }
    }
    
    console.log(`\n接收到 ${eventCount} 个事件`);
    console.log('✓ 流式响应测试通过');
  } catch (error) {
    console.error('✗ 流式响应测试失败:', error.message);
  }
}

// 测试带系统提示词的请求
async function testWithSystem() {
  console.log('\n=== 测试 Claude API 带系统提示词 ===\n');
  
  try {
    const response = await fetchWithRetry(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 4096,
        system: '你是一个专业的数学老师，回答要简洁专业。',
        messages: [
          {
            role: 'user',
            content: '什么是质数？'
          }
        ]
      })
    });
    
    const data = await response.json();
    console.log('响应状态:', response.status);
    console.log('响应数据:', JSON.stringify(data, null, 2));
    
    if (response.status === 200 && data.type === 'message') {
      console.log('\n✓ 系统提示词测试通过');
    } else {
      console.log('\n✗ 系统提示词测试失败');
    }
  } catch (error) {
    console.error('✗ 系统提示词测试失败:', error.message);
  }
}

// 测试多轮对话
async function testMultiTurn() {
  console.log('\n=== 测试 Claude API 多轮对话 ===\n');
  
  try {
    const response = await fetchWithRetry(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: '我叫小明'
          },
          {
            role: 'assistant',
            content: '你好，小明！很高兴认识你。'
          },
          {
            role: 'user',
            content: '我叫什么名字？'
          }
        ]
      })
    });
    
    const data = await response.json();
    console.log('响应状态:', response.status);
    console.log('响应数据:', JSON.stringify(data, null, 2));
    
    if (response.status === 200 && data.type === 'message') {
      console.log('\n✓ 多轮对话测试通过');
    } else {
      console.log('\n✗ 多轮对话测试失败');
    }
  } catch (error) {
    console.error('✗ 多轮对话测试失败:', error.message);
  }
}

// 测试错误处理
async function testErrorHandling() {
  console.log('\n=== 测试 Claude API 错误处理 ===\n');
  
  try {
    // 测试缺少 max_tokens
    const response = await fetchWithRetry(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [
          {
            role: 'user',
            content: '你好'
          }
        ]
      })
    });
    
    const data = await response.json();
    
    if (response.status === 400) {
      console.log('响应状态:', response.status);
      console.log('错误信息:', JSON.stringify(data, null, 2));
      console.log('\n✓ 错误处理测试通过');
    } else {
      console.error('✗ 错误处理测试失败: 应该返回 400 错误');
    }
  } catch (error) {
    console.error('✗ 错误处理测试失败:', error.message);
  }
}

// 运行所有测试
async function runAllTests() {
  console.log('开始测试 Claude API 实现...');
  console.log('确保服务器已启动在', API_BASE);
  console.log('默认模型:', DEFAULT_MODEL);
  
  await testNonStream();
  await testStream();
  await testWithSystem();
  await testMultiTurn();
  await testErrorHandling();
  
  console.log('\n所有测试完成！');
}

// 解析命令行参数运行单个测试
const args = process.argv.slice(2);
if (args.length > 0) {
  const testName = args[0];
  const tests = {
    'nonstream': testNonStream,
    'stream': testStream,
    'system': testWithSystem,
    'multiturn': testMultiTurn,
    'error': testErrorHandling
  };
  
  if (tests[testName]) {
    console.log(`运行单个测试: ${testName}`);
    tests[testName]().catch(console.error);
  } else {
    console.log('可用的测试: nonstream, stream, system, multiturn, error');
    console.log('用法: node test-cc.js [测试名]');
    console.log('不带参数则运行所有测试');
  }
} else {
  runAllTests().catch(console.error);
}

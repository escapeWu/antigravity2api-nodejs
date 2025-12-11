import { generateRequestId } from './idGenerator.js';

/**
 * 将 Antigravity 响应转换为 Claude 非流式格式
 * @param {string} content - 响应内容
 * @param {string} model - 模型名称
 * @param {Object} usage - token 使用统计
 * @returns {Object} Claude 格式的响应
 */
export function antigravityToClaudeResponse(content, model, usage = null) {
  const messageId = `msg_${generateRequestId()}`;
  
  // 提取思维链内容
  let thinkingContent = '';
  let mainContent = content;
  
  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    thinkingContent = thinkMatch[1].trim();
    mainContent = content.replace(/<think>[\s\S]*?<\/think>\s*/, '').trim();
  }
  
  // 构建 content 数组
  const contentBlocks = [];
  
  // 如果有思维链，添加为第一个 block
  if (thinkingContent) {
    contentBlocks.push({
      type: "text",
      text: thinkingContent
    });
  }
  
  // 添加主要内容
  if (mainContent) {
    contentBlocks.push({
      type: "text",
      text: mainContent
    });
  }
  
  // 如果没有任何内容，添加空文本
  if (contentBlocks.length === 0) {
    contentBlocks.push({
      type: "text",
      text: ""
    });
  }
  
  const response = {
    id: messageId,
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model: model,
    stop_reason: "end_turn",
    stop_sequence: null
  };
  
  // 添加 usage 信息
  if (usage) {
    response.usage = {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0
    };
  }
  
  return response;
}

/**
 * 创建 Claude 流式事件数据
 * @param {string} eventType - 事件类型
 * @param {Object} data - 事件数据
 * @returns {string} 格式化的 SSE 事件
 */
export function createClaudeStreamEvent(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 写入 Claude 流式事件到响应
 * @param {Object} res - Express 响应对象
 * @param {string} eventType - 事件类型
 * @param {Object} data - 事件数据
 */
export function writeClaudeStreamEvent(res, eventType, data) {
  res.write(createClaudeStreamEvent(eventType, data));
}

/**
 * 设置 Claude 流式响应头
 * @param {Object} res - Express 响应对象
 */
export function setClaudeStreamHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
}

/**
 * Claude 流式响应处理器
 * 将 Antigravity 的流式数据转换为 Claude 格式
 */
export class ClaudeStreamHandler {
  constructor(res, messageId, model) {
    this.res = res;
    this.messageId = messageId;
    this.model = model;
    this.contentIndex = 0;
    this.hasStarted = false;
    this.thinkingBuffer = '';
    this.inThinking = false;
    this.hasContent = false;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
  }
  
  start() {
    // 发送 message_start 事件
    writeClaudeStreamEvent(this.res, 'message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0
        }
      }
    });
    
    this.hasStarted = true;
  }
  
  handleContent(content) {
    // 检查是否是思维链内容
    if (content.includes('<think>')) {
      this.inThinking = true;
      this.thinkingBuffer = content.replace('<think>', '').replace(/\n$/, '');
      return;
    }
    
    if (this.inThinking) {
      if (content.includes('</think>')) {
        this.thinkingBuffer += content.replace('</think>', '').replace(/\n$/, '');
        this.inThinking = false;
        
        // 发送思维链内容（如果有）
        if (this.thinkingBuffer.trim()) {
          this.sendContentBlock(this.thinkingBuffer.trim());
        }
        this.thinkingBuffer = '';
        return;
      } else {
        this.thinkingBuffer += content;
        return;
      }
    }
    
    // 普通内容
    if (content) {
      this.sendContentBlock(content);
    }
  }
  
  sendContentBlock(text) {
    if (!this.hasContent) {
      // 第一次发送内容，先发送 content_block_start
      writeClaudeStreamEvent(this.res, 'content_block_start', {
        type: 'content_block_start',
        index: this.contentIndex,
        content_block: {
          type: 'text',
          text: ''
        }
      });
      this.hasContent = true;
    }
    
    // 发送内容增量
    writeClaudeStreamEvent(this.res, 'content_block_delta', {
      type: 'content_block_delta',
      index: this.contentIndex,
      delta: {
        type: 'text_delta',
        text: text
      }
    });
  }
  
  handleUsage(usage) {
    this.totalInputTokens = usage.prompt_tokens || 0;
    this.totalOutputTokens = usage.completion_tokens || 0;
  }
  
  end() {
    // 如果有未完成的思维链，发送它
    if (this.inThinking && this.thinkingBuffer.trim()) {
      this.sendContentBlock(this.thinkingBuffer.trim());
    }
    
    // 发送 content_block_stop
    if (this.hasContent) {
      writeClaudeStreamEvent(this.res, 'content_block_stop', {
        type: 'content_block_stop',
        index: this.contentIndex
      });
    }
    
    // 发送 message_delta
    writeClaudeStreamEvent(this.res, 'message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: 'end_turn',
        stop_sequence: null
      },
      usage: {
        output_tokens: this.totalOutputTokens
      }
    });
    
    // 发送 message_stop
    writeClaudeStreamEvent(this.res, 'message_stop', {
      type: 'message_stop'
    });
    
    this.res.end();
  }
}

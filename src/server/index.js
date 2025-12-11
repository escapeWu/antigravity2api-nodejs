import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateAssistantResponse, generateAssistantResponseNoStream, getAvailableModels, generateImageForSD, closeRequester } from '../api/client.js';
import { antigravityToClaudeResponse, setClaudeStreamHeaders, ClaudeStreamHandler } from '../utils/claudeFormat.js';
import { generateRequestBody } from '../utils/utils.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import tokenManager from '../auth/token_manager.js';
import adminRouter from '../routes/admin.js';
import sdRouter from '../routes/sd.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// 工具函数：生成响应元数据
const createResponseMeta = () => ({
  id: `chatcmpl-${Date.now()}`,
  created: Math.floor(Date.now() / 1000)
});

// 工具函数：设置流式响应头
const setStreamHeaders = (res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
};

// 工具函数：构建流式数据块
const createStreamChunk = (id, created, model, delta, finish_reason = null) => ({
  id,
  object: 'chat.completion.chunk',
  created,
  model,
  choices: [{ index: 0, delta, finish_reason }]
});

// 工具函数：写入流式数据
const writeStreamData = (res, data) => {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

// 工具函数：结束流式响应
const endStream = (res) => {
  res.write('data: [DONE]\n\n');
  res.end();
};

app.use(cors());
app.use(express.json({ limit: config.security.maxRequestSize }));

// 静态文件服务
app.use('/images', express.static(path.join(__dirname, '../../public/images')));
app.use(express.static(path.join(__dirname, '../../public')));

// 管理路由
app.use('/admin', adminRouter);

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `请求体过大，最大支持 ${config.security.maxRequestSize}` });
  }
  next(err);
});

app.use((req, res, next) => {
  const ignorePaths = ['/images', '/favicon.ico', '/.well-known', '/sdapi/v1/options', '/sdapi/v1/samplers', '/sdapi/v1/schedulers', '/sdapi/v1/upscalers', '/sdapi/v1/latent-upscale-modes', '/sdapi/v1/sd-vae', '/sdapi/v1/sd-modules'];
  if (!ignorePaths.some(path => req.path.startsWith(path))) {
    const start = Date.now();
    res.on('finish', () => {
      logger.request(req.method, req.path, res.statusCode, Date.now() - start);
    });
  }
  next();
});
app.use('/sdapi/v1', sdRouter);

app.use((req, res, next) => {
  if (req.path.startsWith('/v1/')) {
    const apiKey = config.security?.apiKey;
    if (apiKey) {
      const authHeader = req.headers.authorization;
      const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      if (providedKey !== apiKey) {
        logger.warn(`API Key 验证失败: ${req.method} ${req.path}`);
        return res.status(401).json({ error: 'Invalid API Key' });
      }
    }
  }
  next();
});

app.get('/v1/models', async (req, res) => {
  try {
    const models = await getAvailableModels();
    res.json(models);
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});



app.post('/v1/chat/completions', async (req, res) => {
  const { messages, model, stream = false, tools, ...params} = req.body;
  try {
    if (!messages) {
      return res.status(400).json({ error: 'messages is required' });
    }
    const token = await tokenManager.getToken();
    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }
    const isImageModel = model.includes('-image');
    const requestBody = generateRequestBody(messages, model, params, tools, token);
    if (isImageModel) {
      requestBody.request.generationConfig={
        candidateCount: 1,
        // imageConfig:{
        //   aspectRatio: "1:1"
        // }
      }
      requestBody.requestType="image_gen";
      //requestBody.request.systemInstruction.parts[0].text += "现在你作为绘画模型聚焦于帮助用户生成图片";
      delete requestBody.request.systemInstruction;
      delete requestBody.request.tools;
      delete requestBody.request.toolConfig;
    }
    //console.log(JSON.stringify(requestBody,null,2))
    
    const { id, created } = createResponseMeta();
    
    if (stream) {
      setStreamHeaders(res);
      
      if (isImageModel) {
        //console.log(JSON.stringify(requestBody,null,2));
        const { content, usage } = await generateAssistantResponseNoStream(requestBody, token);
        writeStreamData(res, createStreamChunk(id, created, model, { content }));
        writeStreamData(res, { ...createStreamChunk(id, created, model, {}, 'stop'), usage });
        endStream(res);
      } else {
        let hasToolCall = false;
        let usageData = null;
        await generateAssistantResponse(requestBody, token, (data) => {
          if (data.type === 'usage') {
            usageData = data.usage;
          } else {
            const delta = data.type === 'tool_calls' 
              ? { tool_calls: data.tool_calls } 
              : { content: data.content };
            if (data.type === 'tool_calls') hasToolCall = true;
            writeStreamData(res, createStreamChunk(id, created, model, delta));
          }
        });
        writeStreamData(res, { ...createStreamChunk(id, created, model, {}, hasToolCall ? 'tool_calls' : 'stop'), usage: usageData });
        endStream(res);
      }
    } else {
      const { content, toolCalls, usage } = await generateAssistantResponseNoStream(requestBody, token);
      const message = { role: 'assistant', content };
      if (toolCalls.length > 0) message.tool_calls = toolCalls;
      
      res.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
        }],
        usage
      });
    }
  } catch (error) {
    logger.error('生成响应失败:', error.message);
    if (!res.headersSent) {
      const { id, created } = createResponseMeta();
      const errorContent = `错误: ${error.message}`;
      
      if (stream) {
        setStreamHeaders(res);
        writeStreamData(res, createStreamChunk(id, created, model, { content: errorContent }));
        writeStreamData(res, createStreamChunk(id, created, model, {}, 'stop'));
        endStream(res);
      } else {
        res.json({
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: errorContent },
            finish_reason: 'stop'
          }]
        });
      }
    }
  }
});

// Claude API 端点
app.post('/v1/messages', async (req, res) => {
  const { messages, model, stream = false, system, max_tokens, ...params } = req.body;
  
  try {
    // 验证必填参数
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ 
        type: 'error',
        error: { 
          type: 'invalid_request_error',
          message: 'messages is required and must be an array' 
        }
      });
    }
    
    if (!model) {
      return res.status(400).json({ 
        type: 'error',
        error: { 
          type: 'invalid_request_error',
          message: 'model is required' 
        }
      });
    }
    
    if (!max_tokens) {
      return res.status(400).json({ 
        type: 'error',
        error: { 
          type: 'invalid_request_error',
          message: 'max_tokens is required' 
        }
      });
    }
    
    // 获取 token
    const token = await tokenManager.getToken();
    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }
    
    // 将 Claude messages 转换为 OpenAI 格式
    const openaiMessages = [];
    
    // 不要把 system 添加到 messages 中，而是作为参数传递
    
    // 转换消息
    for (const msg of messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        let content = '';
        if (typeof msg.content === 'string') {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          // 处理多模态内容
          const textBlocks = msg.content.filter(block => block.type === 'text');
          content = textBlocks.map(block => block.text).join('\n');
        }
        openaiMessages.push({ role: msg.role, content });
      }
    }
    
    // 构建请求参数
    const requestParams = {
      ...params,
      max_tokens: max_tokens
    };
    
    // 生成请求体（传递自定义系统提示词）
    const requestBody = generateRequestBody(openaiMessages, model, requestParams, null, token, system);
    
    // 生成消息 ID
    const messageId = `msg_${Date.now()}`;
    
    if (stream) {
      // 流式响应
      setClaudeStreamHeaders(res);
      
      const streamHandler = new ClaudeStreamHandler(res, messageId, model);
      streamHandler.start();
      
      await generateAssistantResponse(requestBody, token, (data) => {
        if (data.type === 'usage') {
          streamHandler.handleUsage(data.usage);
        } else if (data.type === 'text' || data.type === 'thinking') {
          streamHandler.handleContent(data.content);
        }
      });
      
      streamHandler.end();
    } else {
      // 非流式响应
      const { content, usage } = await generateAssistantResponseNoStream(requestBody, token);
      const claudeResponse = antigravityToClaudeResponse(content, model, usage);
      res.json(claudeResponse);
    }
  } catch (error) {
    logger.error('Claude API 生成响应失败:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: error.message
        }
      });
    }
  }
});

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`服务器已启动: ${config.server.host}:${config.server.port}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    logger.error(`端口 ${config.server.port} 无权限访问`);
    process.exit(1);
  } else {
    logger.error('服务器启动失败:', error.message);
    process.exit(1);
  }
});

const shutdown = () => {
  logger.info('正在关闭服务器...');
  closeRequester();
  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

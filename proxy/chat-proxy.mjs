import http from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PROXY_PORT ?? '8788');
const API_KEY = process.env.PROXY_API_KEY ?? '';
const UPSTREAM_BASE = (process.env.PROXY_UPSTREAM ?? 'https://api.deepseek.com').replace(/\/+$/, '');

if (!API_KEY) {
  console.error('PROXY_API_KEY env var is required');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  const path = req.url ?? '/';

  // Health check
  if (method === 'GET' && path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Only handle /v1/responses
  if (method !== 'POST' || !path.startsWith('/v1/responses')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `not found: ${method} ${path}` }));
    return;
  }

  const rawBody = await readBody(req);
  const body = JSON.parse(rawBody.toString('utf8'));
  const isStream = body.stream === true;

  console.log(`[request] model=${body.model} stream=${isStream} inputItems=${countItems(body.input)} tools=${body.tools?.length ?? 0}`);

  // Convert Responses API request → Chat Completions request
  const ccReq = toChatCompletionsRequest(body);
  const ccBody = JSON.stringify(ccReq);

  try {
    const upstream = await fetch(`${UPSTREAM_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${API_KEY}`,
      },
      body: ccBody,
    });

    if (!upstream.ok && !isStream) {
      const errText = await upstream.text();
      console.error(`[upstream error] ${upstream.status}: ${errText.slice(0, 500)}`);
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(errText);
      return;
    }

    if (isStream) {
      // Streaming: convert Chat Completions SSE → Responses API SSE
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      });
      await handleStream(upstream, res, body.model);
    } else {
      // Non-streaming: convert response
      const ccResp = await upstream.json();
      const resp = toResponsesResult(ccResp, body.model);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(resp));
    }
  } catch (err) {
    console.error('[proxy error]', err.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
});

// ── Request conversion: Responses API → Chat Completions ──

function toChatCompletionsRequest(body) {
  const messages = convertInput(body.input, body.instructions);
  const tools = convertTools(body.tools);

  const req = {
    model: body.model,
    messages,
    stream: body.stream ?? false,
  };

  if (tools.length > 0) {
    req.tools = tools;
    req.tool_choice = body.tool_choice ?? 'auto';
  }

  // Pass through reasoning_effort if present
  if (body.reasoning?.effort) {
    // DeepSeek doesn't use reasoning_effort the same way; ignore for now
  }

  // temperature
  if (body.temperature != null) {
    req.temperature = body.temperature;
  }

  // max_output_tokens
  if (body.max_output_tokens != null) {
    req.max_tokens = body.max_output_tokens;
  }

  return req;
}

function convertInput(input, instructions) {
  const messages = [];

  // Add system instructions as a system message
  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  if (!input) return messages;

  // input can be a string
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  // input can be an array of items
  for (const item of input) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }

    if (!item || typeof item !== 'object') continue;

    switch (item.type) {
      case 'message': {
        const content = convertContent(item.content);
        const role = item.role === 'developer' ? 'system' : item.role;
        messages.push({ role, content });
        break;
      }
      case 'function_call': {
        messages.push({
          role: 'assistant',
          tool_calls: [{
            id: item.call_id ?? item.id ?? crypto.randomUUID(),
            type: 'function',
            function: {
              name: item.name,
              arguments: item.arguments ?? '{}',
            },
          }],
        });
        break;
      }
      case 'function_call_output': {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id ?? '',
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
        });
        break;
      }
      default: {
        // Fallback: try to use as a message
        if (item.role && item.content) {
          const role = item.role === 'developer' ? 'system' : item.role;
          messages.push({ role, content: convertContent(item.content) });
        }
      }
    }
  }

  return messages;
}

function convertContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const textParts = [];
    for (const part of content) {
      if (typeof part === 'string') {
        textParts.push(part);
      } else if (part.type === 'input_text') {
        textParts.push(part.text ?? '');
      } else if (part.type === 'text') {
        textParts.push(part.text ?? '');
      }
    }
    return textParts.join('\n');
  }

  return String(content);
}

function convertTools(tools) {
  if (!tools || !Array.isArray(tools)) return [];

  return tools.map(tool => {
    if (tool.type === 'function' || !tool.type) {
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description ?? '',
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
      };
    }
    return tool;
  });
}

// ── Response conversion: Chat Completions → Responses API ──

function toResponsesResult(ccResp, model) {
  const choice = ccResp.choices?.[0];
  if (!choice) {
    return {
      id: `resp_${ccResp.id ?? crypto.randomUUID()}`,
      object: 'response',
      model: ccResp.model ?? model,
      output: [],
      status: 'completed',
      usage: convertUsage(ccResp.usage),
    };
  }

  const output = [];
  const msg = choice.message;

  if (msg.content) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: msg.content }],
    });
  }

  if (msg.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: 'function_call',
        id: tc.id,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
  }

  // If no content and no tool calls, add empty message
  if (output.length === 0) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '' }],
    });
  }

  return {
    id: `resp_${ccResp.id ?? crypto.randomUUID()}`,
    object: 'response',
    model: ccResp.model ?? model,
    output,
    status: choice.finish_reason === 'tool_calls' ? 'incomplete' : 'completed',
    usage: convertUsage(ccResp.usage),
  };
}

function convertUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
}

// ── Streaming conversion ──

async function handleStream(upstream, res, model) {
  const respId = `resp_${crypto.randomUUID()}`;
  const itemId = crypto.randomUUID();
  let outputIndex = 0;
  let functionName = '';
  let functionCallId = '';
  let functionArgs = '';
  let inToolCall = false;
  let textStarted = false;

  // Send initial events
  sendSSE(res, 'response.created', {
    type: 'response.created',
    response: { id: respId, object: 'response', model, status: 'in_progress', output: [] },
  });

  // Start a text output item
  sendSSE(res, 'response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'message', id: `msg_${itemId}`, role: 'assistant', content: [] },
  });

  sendSSE(res, 'response.content_part.added', {
    type: 'response.content_part.added',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '' },
  });

  textStarted = true;

  const decoder = new TextDecoder();
  let buffer = '';
  let totalText = '';
  let usage = null;

  for await (const chunk of Readable.fromWeb(upstream.body)) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (trimmed === 'data: [DONE]') {
        // End of stream - will be handled after loop
        continue;
      }

      if (!trimmed.startsWith('data: ')) continue;
      const jsonStr = trimmed.slice(6);

      let parsed;
      try { parsed = JSON.parse(jsonStr); } catch { continue; }

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) {
        if (parsed.usage) usage = parsed.usage;
        continue;
      }

      // Handle text content
      if (delta.content != null) {
        totalText += delta.content;
        sendSSE(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: delta.content,
        });
      }

      // Handle tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          // Start of a new tool call
          if (tc.function?.name) {
            // Close the text item first if we had one
            if (textStarted) {
              sendSSE(res, 'response.output_text.done', {
                type: 'response.output_text.done',
                output_index: 0,
                content_index: 0,
                text: totalText,
              });

              sendSSE(res, 'response.output_item.done', {
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                  type: 'message',
                  id: `msg_${itemId}`,
                  role: 'assistant',
                  content: totalText ? [{ type: 'output_text', text: totalText }] : [],
                },
              });
              textStarted = false;
            }

            outputIndex++;
            functionName = tc.function.name;
            functionCallId = tc.id ?? crypto.randomUUID();
            functionArgs = '';
            inToolCall = true;

            sendSSE(res, 'response.output_item.added', {
              type: 'response.output_item.added',
              output_index: outputIndex,
              item: {
                type: 'function_call',
                id: functionCallId,
                call_id: functionCallId,
                name: functionName,
                arguments: '',
              },
            });
          }

          // Arguments delta
          if (tc.function?.arguments) {
            functionArgs += tc.function.arguments;
            sendSSE(res, 'response.function_call_arguments.delta', {
              type: 'response.function_call_arguments.delta',
              output_index: outputIndex,
              delta: tc.function.arguments,
            });
          }
        }
      }

      if (parsed.usage) usage = parsed.usage;
    }
  }

  // Close text item if still open
  if (textStarted) {
    sendSSE(res, 'response.output_text.done', {
      type: 'response.output_text.done',
      output_index: 0,
      content_index: 0,
      text: totalText,
    });

    sendSSE(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: `msg_${itemId}`,
        role: 'assistant',
        content: totalText ? [{ type: 'output_text', text: totalText }] : [],
      },
    });
  }

  // Close tool call items
  if (inToolCall) {
    sendSSE(res, 'response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      output_index: outputIndex,
      arguments: functionArgs,
    });

    sendSSE(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: {
        type: 'function_call',
        id: functionCallId,
        call_id: functionCallId,
        name: functionName,
        arguments: functionArgs,
      },
    });
  }

  // Send final completed event
  const fullOutput = [];

  if (totalText || !inToolCall) {
    fullOutput.push({
      type: 'message',
      id: `msg_${itemId}`,
      role: 'assistant',
      content: totalText ? [{ type: 'output_text', text: totalText }] : [],
    });
  }

  if (inToolCall) {
    fullOutput.push({
      type: 'function_call',
      id: functionCallId,
      call_id: functionCallId,
      name: functionName,
      arguments: functionArgs,
    });
  }

  sendSSE(res, 'response.completed', {
    type: 'response.completed',
    response: {
      id: respId,
      object: 'response',
      model,
      status: inToolCall ? 'incomplete' : 'completed',
      output: fullOutput,
      usage: convertUsage(usage),
    },
  });

  res.end();
  console.log(`[completed] text=${totalText.length}chars toolCalls=${inToolCall ? 1 : 0}`);
}

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Utilities ──

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function countItems(input) {
  if (!input) return 0;
  if (Array.isArray(input)) return input.length;
  return 1;
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`chat-proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`  upstream: ${UPSTREAM_BASE}/chat/completions`);
});

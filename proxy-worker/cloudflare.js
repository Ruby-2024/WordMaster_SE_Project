const DEFAULT_API_KEY = '';

function corsHeaders(env) {
  const allow = (env.ALLOW_ORIGINS || '*').trim();
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-DS-Key'
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }
    
    // 路由检查
    if (url.pathname !== '/api/chat' || request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Use POST /api/chat' }), { 
        status: 404, 
        headers: corsHeaders(env) 
      });
    }

    // 请求体解析
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: corsHeaders(env)
      });
    }

    // 基本验证
    if (!body.messages || !Array.isArray(body.messages)) {
      return new Response(JSON.stringify({ error: 'Missing or invalid messages array' }), {
        status: 400,
        headers: corsHeaders(env)
      });
    }

    // API Key 优先级
    const userKey = request.headers.get('X-DS-Key');
    const envKey = env.DEEPSEEK_API_KEY;
    const apiKey = userKey || envKey || DEFAULT_API_KEY;

    if (!apiKey || apiKey === 'sk-') {
      return new Response(JSON.stringify({ error: 'No API key configured' }), {
        status: 500,
        headers: corsHeaders(env)
      });
    }

    try {
      const upstream = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: body.messages,
          model: body.model || 'deepseek-chat',
          temperature: body.temperature ?? 0.7,
          max_tokens: body.max_tokens ?? 2048,
          stream: body.stream === true
        })
      });

      // 流式响应处理
      if (body.stream) {
        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            ...corsHeaders(env),
            'Content-Type': 'text/plain; charset=utf-8'
          }
        });
      }

      // 非流式响应处理
      const data = await upstream.text();
      
      if (!upstream.ok) {
        return new Response(JSON.stringify({
          error: 'Upstream API error',
          status: upstream.status,
          details: data
        }), {
          status: upstream.status,
          headers: corsHeaders(env)
        });
      }

      return new Response(data, {
        status: upstream.status,
        headers: {
          ...corsHeaders(env),
          'Content-Type': 'application/json'
        }
      });

    } catch (error) {
      return new Response(JSON.stringify({ 
        error: 'Network error', 
        details: error.message 
      }), {
        status: 500,
        headers: corsHeaders(env)
      });
    }
  }
};
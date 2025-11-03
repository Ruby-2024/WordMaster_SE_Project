/* 与代理交互的封装
   - 前端仍仅调用你的 Worker（/api/chat）
   - 若用户填了自有 Key，则通过自定义头 X-DS-Key 发送给 Worker 使用
*/
window.vlAI = {
  async chat(messages, opts) {
    const base = (opts?.base || '').replace(/\/+$/,'');
    if (!base) throw new Error('AI_BASE 未设置');
    
    const apiKey = opts?.userKey || ''; // 使用默认 key
    
    const body = {
      messages: [
        { role: 'system', content: (opts?.system || 'You are a professional English dictionary and language tutor. Your task is to provide clear, accurate, and concise explanations for any English word or phrase provided by the user. Your response must include the part of speech, a precise Chinese definition, and one or more authentic English example sentences with clear Chinese translations. Maintain a clear and professional format.') },
        ...messages
      ],
      model: opts?.model || 'deepseek-chat',
      temperature: opts?.temperature ?? 0.7,
      max_tokens: opts?.max_tokens ?? 2048,
      stream: false
    };

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || JSON.stringify(data);
  }
};

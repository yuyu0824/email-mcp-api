javascript
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

module.exports = async (req, res) => {
  // 处理跨域请求（CORS）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const body = req.body;
  const { jsonrpc, id, method, params } = body;

  // 发送成功回复的“小助手”
  const sendResult = (result) => {
    res.json({ jsonrpc: '2.0', id, result });
  };

  // 发送错误回复的“小助手”
  const sendError = (code, message) => {
    res.json({ jsonrpc: '2.0', id, error: { code, message } });
  };

  // 1. 处理 MCP 的“打招呼”（必须的握手步骤）
  if (method === 'initialize') {
    return sendResult({
      protocolVersion: '0.1.0',
      capabilities: { tools: {} },
      serverInfo: { name: 'email-mcp-api' }
    });
  }

  // 2. 告诉 MCP 你有哪些“工具”（列出 send_mail 和 check_mail）
  if (method === 'tools/list') {
    return sendResult({
      tools: [
        {
          name: 'send_mail',
          description: '给对方发送一封真实邮件',
          inputSchema: {
            type: 'object',
            properties: {
              subject: { type: 'string', description: '邮件主题' },
              content: { type: 'string', description: '邮件正文' },
              sender_name: { type: 'string', description: '发件人名称' }
            },
            required: ['content']
          }
        },
        {
          name: 'check_mail',
          description: '读取收件箱里最新的未读邮件',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        }
      ]
    });
  }

  // 3. 真正干活的地方（调用发信或收信）
  if (method === 'tools/call') {
    const toolName = params.name;
    const args = params.arguments || {};

    // 处理“发信”请求
    if (toolName === 'send_mail') {
      try {
        const { subject, content, sender_name } = args;
        // 检查必填项
        if (!subject || !content) {
          return sendError(-32602, '缺少 subject 或 content 参数');
        }

        const displayName = sender_name || 'AI Companion';
        const transporter = nodemailer.createTransport({
          host: 'smtp.qq.com',
          port: 465,
          secure: true,
          auth: {
            user: process.env.QQ_EMAIL,
            pass: process.env.QQ_AUTH_CODE
          }
        });

        const info = await transporter.sendMail({
          from: `"${displayName}" <${process.env.QQ_EMAIL}>`,
          to: process.env.TO_EMAIL || process.env.QQ_EMAIL,
          subject: subject,
          text: content
        });

        return sendResult({
          content: [
            { type: 'text', text: JSON.stringify({ success: true, messageId: info.messageId }) }
          ]
        });
      } catch (err) {
        return sendError(-32000, err.message);
      }
    }

    // 处理“收信”请求
    if (toolName === 'check_mail') {
      try {
        const client = new ImapFlow({
          host: 'imap.qq.com',
          port: 993,
          secure: true,
          auth: {
            user: process.env.QQ_EMAIL,
            pass: process.env.QQ_AUTH_CODE
          },
          logger: false
        });

        await client.connect();
        let lock = await client.getMailboxLock('INBOX');
        let messages = [];
        try {
          let searchResult = await client.search({ unseen: true });
          if (searchResult && searchResult.length > 0) {
            let targetSeq = searchResult.slice(-3);
            let range = targetSeq.join(',');
            for await (let message of client.fetch(range, { envelope: true, source: true })) {
              let parsed = await simpleParser(message.source);
              messages.push({
                subject: message.envelope.subject || '无主题',
                from: message.envelope.from?.[0]?.address || '未知发件人',
                date: message.envelope.date,
                content: (parsed.text || '（无文字正文）').trim().slice(0, 500)
              });
            }
            messages.reverse();
            await client.messageFlagsAdd(range, ['\\Seen']);
          }
        } finally {
          lock.release();
        }
        await client.logout();

        let resultText = '';
        if (messages.length === 0) {
          resultText = '当前没有收到新的未读邮件（之前的邮件已阅读过，对方尚未回复）。';
        } else {
          resultText = JSON.stringify({ count: messages.length, emails: messages });
        }

        return sendResult({
          content: [
            { type: 'text', text: resultText }
          ]
        });
      } catch (err) {
        return sendError(-32000, err.message);
      }
    }

    return sendError(-32601, '未找到该工具');
  }

  // 其他不认识的请求
  return sendError(-32601, 'Method not found');
};

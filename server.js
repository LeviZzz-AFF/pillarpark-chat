require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('public'));

// ── In-memory message store ──────────────────────────────────
const conversations = {};

function getOrCreate(phone, name) {
  if (!conversations[phone]) {
    conversations[phone] = { name: name || phone, phone, messages: [], unread: 0 };
  }
  return conversations[phone];
}

// ── WhatsApp API helper ───────────────────────────────────────
const WA = axios.create({
  baseURL: `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}`,
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

// ── WEBHOOK VERIFY ────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

// ── WEBHOOK RECEIVE ───────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;

      if (value.messages) {
        for (const msg of value.messages) {
          const phone = msg.from;
          const contact = (value.contacts || []).find(c => c.wa_id === phone);
          const name = contact?.profile?.name || phone;
          const conv = getOrCreate(phone, name);

          let text = '';
          let mediaUrl = null;
          let mediaType = null;

          if (msg.type === 'text') {
            text = msg.text?.body || '';
          } else if (msg.type === 'image') {
            text = '📷 Image';
            mediaType = 'image';
            try {
              const mediaId = msg.image?.id;
              if (mediaId) {
                const mediaInfo = await axios.get(`https://graph.facebook.com/v22.0/${mediaId}`, {
                  headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
                });
                mediaUrl = mediaInfo.data.url;
              }
            } catch (e) {}
          } else if (msg.type === 'audio') {
            text = '🎵 Audio';
            mediaType = 'audio';
          } else if (msg.type === 'video') {
            text = '🎥 Video';
            mediaType = 'video';
          } else if (msg.type === 'document') {
            text = msg.document?.filename || '📄 Document';
            mediaType = 'document';
          } else if (msg.type === 'sticker') {
            text = '🎨 Sticker';
          } else {
            text = `[${msg.type}]`;
          }

          conv.messages.push({
            id: msg.id,
            from: 'them',
            text,
            type: msg.type,
            mediaUrl,
            mediaType,
            time: new Date(parseInt(msg.timestamp) * 1000).toISOString()
          });
          conv.unread++;
          conv.lastMessage = text;
          conv.lastTime = new Date(parseInt(msg.timestamp) * 1000).toISOString();
          console.log(`📩 ${name} (${phone}): ${text}`);

          try {
            await WA.post('/messages', { messaging_product: 'whatsapp', status: 'read', message_id: msg.id });
          } catch (e) {}
        }
      }

      if (value.statuses) {
        for (const status of value.statuses) {
          for (const conv of Object.values(conversations)) {
            const msg = conv.messages.find(m => m.id === status.id);
            if (msg) msg.status = status.status;
          }
        }
      }
    }
  }
});

// ── API: Get all conversations ────────────────────────────────
app.get('/api/conversations', (req, res) => {
  const list = Object.values(conversations)
    .sort((a, b) => new Date(b.lastTime || 0) - new Date(a.lastTime || 0));
  res.json(list);
});

// ── API: Get messages for a conversation ──────────────────────
app.get('/api/conversations/:phone', (req, res) => {
  const conv = conversations[req.params.phone];
  if (!conv) return res.json({ phone: req.params.phone, messages: [], unread: 0 });
  conv.unread = 0;
  res.json(conv);
});

// ── API: Send a text/template message ────────────────────────
app.post('/api/send', async (req, res) => {
  const { to, message, type, templateName, templateLang } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing recipient' });

  try {
    let payload;
    if (type === 'template') {
      payload = {
        messaging_product: 'whatsapp',
        to: to.replace('+', '').replace(/\s/g, ''),
        type: 'template',
        template: { name: templateName, language: { code: templateLang || 'en_US' } }
      };
    } else {
      payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to.replace('+', '').replace(/\s/g, ''),
        type: 'text',
        text: { preview_url: false, body: message }
      };
    }

    const result = await WA.post('/messages', payload);
    const msgId = result.data?.messages?.[0]?.id;

    const conv = getOrCreate(to.replace('+', '').replace(/\s/g, ''), to);
    const text = type === 'template' ? `[Template: ${templateName}]` : message;
    conv.messages.push({ id: msgId, from: 'me', text, status: 'sent', time: new Date().toISOString() });
    conv.lastMessage = text;
    conv.lastTime = new Date().toISOString();

    res.json({ success: true, messageId: msgId });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ── API: Send media ───────────────────────────────────────────
app.post('/api/send-media', upload.single('file'), async (req, res) => {
  const { to } = req.body;
  if (!to || !req.file) return res.status(400).json({ error: 'Missing recipient or file' });

  const toClean = to.replace('+', '').replace(/\s/g, '');
  const file = req.file;
  const mimeType = file.mimetype;

  try {
    // Step 1: Upload media to WhatsApp
    const form = new FormData();
    form.append('file', fs.createReadStream(file.path), {
      filename: file.originalname || 'file',
      contentType: mimeType
    });
    form.append('messaging_product', 'whatsapp');

    const uploadRes = await axios.post(
      `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/media`,
      form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );
    const mediaId = uploadRes.data.id;

    // Step 2: Determine media type
    let waType = 'document';
    if (mimeType.startsWith('image/')) waType = 'image';
    else if (mimeType.startsWith('video/')) waType = 'video';
    else if (mimeType.startsWith('audio/')) waType = 'audio';

    // Step 3: Send message
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toClean,
      type: waType,
      [waType]: { id: mediaId }
    };
    if (waType === 'document') payload.document.filename = file.originalname;

    const sendRes = await WA.post('/messages', payload);
    const msgId = sendRes.data?.messages?.[0]?.id;

    const conv = getOrCreate(toClean, to);
    const text = waType === 'image' ? '📷 Image' : waType === 'video' ? '🎥 Video' : waType === 'audio' ? '🎵 Audio' : `📄 ${file.originalname}`;
    conv.messages.push({ id: msgId, from: 'me', text, mediaType: waType, status: 'sent', time: new Date().toISOString() });
    conv.lastMessage = text;
    conv.lastTime = new Date().toISOString();

    // Clean up temp file
    fs.unlink(file.path, () => {});

    res.json({ success: true, messageId: msgId });
  } catch (err) {
    fs.unlink(file.path, () => {});
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ── API: Get templates ────────────────────────────────────────
app.get('/api/templates', async (req, res) => {
  try {
    const result = await axios.get(
      `https://graph.facebook.com/v22.0/${process.env.WABA_ID}/message_templates?limit=100&fields=name,language,status,components`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );
    const approved = (result.data.data || []).filter(t =>
      t.status === 'APPROVED' || t.status === 'ACTIVE'
    );
    res.json(approved);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ── API: Bulk send ────────────────────────────────────────────
app.post('/api/bulk', async (req, res) => {
  const { numbers, message, type, templateName, templateLang, delay } = req.body;
  if (!numbers || numbers.length === 0) return res.status(400).json({ error: 'No numbers' });
  res.json({ success: true, total: numbers.length, message: 'Bulk send started' });

  for (const number of numbers) {
    try {
      const to = number.replace('+', '').replace(/\s/g, '');
      let payload;
      if (type === 'template') {
        payload = { messaging_product: 'whatsapp', to, type: 'template', template: { name: templateName, language: { code: templateLang || 'en_US' } } };
      } else {
        payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: message } };
      }
      await WA.post('/messages', payload);
      console.log(`✓ Sent to ${number}`);
    } catch (e) {
      console.log(`✗ Failed ${number}: ${e.response?.data?.error?.message || e.message}`);
    }
    await new Promise(r => setTimeout(r, delay || 2000));
  }
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Pillar Park Chat running on port ${PORT}`));

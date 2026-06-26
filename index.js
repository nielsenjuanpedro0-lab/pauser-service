const YCLOUD_COOKIE = 'remember-me=anVhbm1hdGlhczE5OTYlNDBnbWFpbC5jb206MTc4NDY2Njk3NjQ5ODpjMDY5MWE5NzUyMmI1NzM5ZTgxNjRhZTA2NTZmZDU3Mg';
const JUAN_AGENT_ID = '6a32cf72dc383e50473183ca';
const SUPABASE_URL = 'https://qukgtlwessujumdmfgnm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1a2d0bHdlc3N1anVtZG1mZ25tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM3MjY1MCwiZXhwIjoyMDg3OTQ4NjUwfQ.iWPH9PEGNixiZUPl8f-pJLv7dl6wBeOEw9psOnlrMq4';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '15000');

async function getJuanConversations() {
  const resp = await fetch('https://www.ycloud.com/api/inbox/conversation/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: YCLOUD_COOKIE },
    body: JSON.stringify({ pageNum: 1, pageSize: 100 }),
  });
  if (!resp.ok) throw new Error(`ycloud list failed: ${resp.status}`);
  const data = await resp.json();
  const conversations = data?.data?.conversation || [];
  return conversations.filter(c => c.assigneeId === JUAN_AGENT_ID);
}

function extractCustomerPhone(conv) {
  // Prefer contact.phoneNumber (always the customer)
  if (conv.contact?.phoneNumber) return conv.contact.phoneNumber.replace(/\D/g, '');
  // Fallback: scan messages
  for (const msg of conv.messages || []) {
    if (msg.messageDirection === 0 && msg.from) return msg.from.replace(/\D/g, '');
    if (msg.messageDirection === 1 && msg.to)  return msg.to.replace(/\D/g, '');
  }
  return null;
}

async function getSupabaseEstado(phone) {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/memoria_ram?telefono=ilike.*${phone}*&select=telefono,estado_conversacion&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!resp.ok) throw new Error(`supabase GET failed: ${resp.status}`);
  const rows = await resp.json();
  return rows[0]?.estado_conversacion || '';
}

async function pauseInSupabase(phone) {
  const expiry = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/memoria_ram?telefono=ilike.*${phone}*`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ estado_conversacion: `PAUSADO:${expiry}` }),
    }
  );
  if (!resp.ok) throw new Error(`supabase PATCH failed: ${resp.status}`);
}

async function poll() {
  const convs = await getJuanConversations();
  if (convs.length === 0) return;

  for (const conv of convs) {
    const phone = extractCustomerPhone(conv);
    if (!phone) continue;

    const estado = await getSupabaseEstado(phone);
    if (estado.startsWith('PAUSADO') || estado.startsWith('DERIVADO')) continue;

    await pauseInSupabase(phone);
    console.log(`[${new Date().toISOString()}] PAUSADO → ${phone} (conv: ${conv.id})`);
  }
}

async function run() {
  console.log(`NecoBot Pauser arrancado. Intervalo: ${POLL_INTERVAL_MS / 1000}s`);
  while (true) {
    try {
      await poll();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Minimal HTTP server so easypanel healthcheck passes
require('http').createServer((_, res) => res.end('ok')).listen(3000);

run();

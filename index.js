const YCLOUD_COOKIE = 'remember-me=anVhbm1hdGlhczE5OTYlNDBnbWFpbC5jb206MTc4NDY2Njk3NjQ5ODpjMDY5MWE5NzUyMmI1NzM5ZTgxNjRhZTA2NTZmZDU3Mg';
const JUAN_AGENT_ID = '6a32cf72dc383e50473183ca';
const SUPABASE_URL = 'https://qukgtlwessujumdmfgnm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1a2d0bHdlc3N1anVtZG1mZ25tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM3MjY1MCwiZXhwIjoyMDg3OTQ4NjUwfQ.iWPH9PEGNixiZUPl8f-pJLv7dl6wBeOEw9psOnlrMq4';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '15000');

// ── ycloud helpers ──────────────────────────────────────────────────────────

async function getAllConversations() {
  const resp = await fetch('https://www.ycloud.com/api/inbox/conversation/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: YCLOUD_COOKIE },
    body: JSON.stringify({ pageNum: 1, pageSize: 100 }),
  });
  if (!resp.ok) throw new Error(`ycloud list failed: ${resp.status}`);
  const data = await resp.json();
  return data?.data?.conversation || [];
}

function extractCustomerPhone(conv) {
  if (conv.contact?.phoneNumber) return conv.contact.phoneNumber.replace(/\D/g, '');
  for (const msg of conv.messages || []) {
    if (msg.messageDirection === 0 && msg.from) return msg.from.replace(/\D/g, '');
    if (msg.messageDirection === 1 && msg.to)  return msg.to.replace(/\D/g, '');
  }
  return null;
}

async function assignJuan(convId) {
  const resp = await fetch('https://www.ycloud.com/api/inbox/conversation/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: YCLOUD_COOKIE },
    body: JSON.stringify({ agentId: JUAN_AGENT_ID, conversationId: convId, teamId: '', unassigned: false }),
  });
  if (!resp.ok) throw new Error(`ycloud assign failed: ${resp.status}`);
}

async function unassignJuan(convId) {
  const resp = await fetch('https://www.ycloud.com/api/inbox/conversation/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: YCLOUD_COOKIE },
    body: JSON.stringify({ agentId: '', conversationId: convId, teamId: '', unassigned: true }),
  });
  if (!resp.ok) throw new Error(`ycloud unassign failed: ${resp.status}`);
}

// ── Supabase helpers ────────────────────────────────────────────────────────

async function getSupabaseRows(phoneFilter) {
  const url = phoneFilter
    ? `${SUPABASE_URL}/rest/v1/memoria_ram?telefono=ilike.*${phoneFilter}*&select=telefono,estado_conversacion&limit=1`
    : `${SUPABASE_URL}/rest/v1/memoria_ram?select=telefono,estado_conversacion`;
  const resp = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!resp.ok) throw new Error(`supabase GET failed: ${resp.status}`);
  return await resp.json();
}

async function setSupabaseEstado(phone, estado) {
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
      body: JSON.stringify({ estado_conversacion: estado }),
    }
  );
  if (!resp.ok) throw new Error(`supabase PATCH failed: ${resp.status}`);
}

// ── Main sync logic ─────────────────────────────────────────────────────────

async function poll() {
  const convs = await getAllConversations();
  const juanConvs = convs.filter(c => c.assigneeId === JUAN_AGENT_ID);
  const juanPhones = new Set();

  // Direction 1: ycloud assigned to Juan → ensure Supabase = PAUSADO
  for (const conv of juanConvs) {
    const phone = extractCustomerPhone(conv);
    if (!phone) continue;
    juanPhones.add(phone);

    const rows = await getSupabaseRows(phone.slice(-10));
    const estado = rows[0]?.estado_conversacion || '';

    if (!estado.startsWith('PAUSADO') && !estado.startsWith('DERIVADO')) {
      const expiry = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      await setSupabaseEstado(phone.slice(-10), `PAUSADO:${expiry}`);
      console.log(`[${new Date().toISOString()}] PAUSADO → ${phone} (conv: ${conv.id})`);
    }
  }

  // Direction 2: Supabase = DERIVADO → ensure ycloud assigned to Juan
  const allRows = await getSupabaseRows(null);
  const derivedRows = allRows.filter(r => r.estado_conversacion?.startsWith('DERIVADO'));

  for (const row of derivedRows) {
    const phone = row.telefono.replace(/\D/g, '');
    // Find their ycloud conv
    const conv = convs.find(c => {
      const p = extractCustomerPhone(c);
      return p && p.endsWith(phone.slice(-10));
    });
    if (!conv) continue;
    if (conv.assigneeId === JUAN_AGENT_ID) continue; // already assigned

    await assignJuan(conv.id);
    console.log(`[${new Date().toISOString()}] ASIGNADO Juan → ${phone} (conv: ${conv.id})`);
  }

  // Direction 3: Supabase = ACTIVO (empty) but ycloud still assigned to Juan → unassign
  for (const conv of juanConvs) {
    const phone = extractCustomerPhone(conv);
    if (!phone) continue;
    const rows = await getSupabaseRows(phone.slice(-10));
    const estado = rows[0]?.estado_conversacion || '';

    if (!estado.startsWith('PAUSADO') && !estado.startsWith('DERIVADO')) {
      await unassignJuan(conv.id);
      console.log(`[${new Date().toISOString()}] DESASIGNADO Juan → ${phone} (conv: ${conv.id})`);
    }
  }
}

async function run() {
  console.log(`NecoBot Sync arrancado. Intervalo: ${POLL_INTERVAL_MS / 1000}s`);
  while (true) {
    try {
      await poll();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

require('http').createServer((_, res) => res.end('ok')).listen(3000);
run();

const YCLOUD_COOKIE = 'remember-me=anVhbm1hdGlhczE5OTYlNDBnbWFpbC5jb206MTc4NDY2Njk3NjQ5ODpjMDY5MWE5NzUyMmI1NzM5ZTgxNjRhZTA2NTZmZDU3Mg';
const JUAN_AGENT_ID = '6a32cf72dc383e50473183ca';
const SUPABASE_URL = 'https://qukgtlwessujumdmfgnm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1a2d0bHdlc3N1anVtZG1mZ25tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM3MjY1MCwiZXhwIjoyMDg3OTQ4NjUwfQ.iWPH9PEGNixiZUPl8f-pJLv7dl6wBeOEw9psOnlrMq4';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '15000');

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

async function ycloudTransfer(convId, agentId, unassigned) {
  const resp = await fetch('https://www.ycloud.com/api/inbox/conversation/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: YCLOUD_COOKIE },
    body: JSON.stringify({ agentId, conversationId: convId, teamId: '', unassigned }),
  });
  if (!resp.ok) throw new Error(`ycloud transfer failed: ${resp.status}`);
}

async function getSupabaseEstado(phoneDigits) {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/memoria_ram?telefono=ilike.*${phoneDigits}*&select=telefono,estado_conversacion&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!resp.ok) throw new Error(`supabase GET failed: ${resp.status}`);
  const rows = await resp.json();
  return rows[0]?.estado_conversacion || '';
}

async function supabasePatch(phoneDigits, estado) {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/memoria_ram?telefono=ilike.*${phoneDigits}*`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({ estado_conversacion: estado }),
    }
  );
  if (!resp.ok) throw new Error(`supabase PATCH failed: ${resp.status}`);
}

async function getAllSupabaseRows() {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/memoria_ram?select=telefono,estado_conversacion`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!resp.ok) throw new Error(`supabase GET all failed: ${resp.status}`);
  return await resp.json();
}

async function poll() {
  const convs = await getAllConversations();
  const juanConvs = convs.filter(c => c.assigneeId === JUAN_AGENT_ID);

  // Direction A: Juan assigned in ycloud → check Supabase
  // Supabase ACTIVO (empty) = admin cleared it intentionally → UNASSIGN Juan (Supabase wins)
  // Supabase not PAUSADO/DERIVADO → set PAUSADO (new assignment by Juan)
  for (const conv of juanConvs) {
    const phone = extractCustomerPhone(conv);
    if (!phone) continue;
    const digits = phone.slice(-10);
    const estado = await getSupabaseEstado(digits);

    if (estado === '') {
      // Admin cleared Supabase → bot should take over → unassign Juan
      await ycloudTransfer(conv.id, '', true);
      console.log(`[${new Date().toISOString()}] DESASIGNADO (admin despausó) → ${phone}`);
    } else if (!estado.startsWith('PAUSADO') && !estado.startsWith('DERIVADO')) {
      // Shouldn't happen but handle gracefully
      await ycloudTransfer(conv.id, '', true);
      console.log(`[${new Date().toISOString()}] DESASIGNADO (estado desconocido) → ${phone}`);
    } else if (!estado.startsWith('PAUSADO')) {
      // DERIVADO but not PAUSADO yet → set PAUSADO
      const expiry = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      await supabasePatch(digits, `PAUSADO:${expiry}`);
      console.log(`[${new Date().toISOString()}] PAUSADO (desde DERIVADO) → ${phone}`);
    }
    // If already PAUSADO → nothing to do
  }

  // Direction B: Supabase DERIVADO → assign Juan in ycloud if not already
  const allRows = await getAllSupabaseRows();
  for (const row of allRows.filter(r => r.estado_conversacion?.startsWith('DERIVADO'))) {
    const phone = row.telefono.replace(/\D/g, '');
    const conv = convs.find(c => {
      const p = extractCustomerPhone(c);
      return p && p.endsWith(phone.slice(-10));
    });
    if (!conv) continue;
    if (conv.assigneeId === JUAN_AGENT_ID) continue;

    await ycloudTransfer(conv.id, JUAN_AGENT_ID, false);
    // Also set PAUSADO in Supabase
    const expiry = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    await supabasePatch(phone.slice(-10), `PAUSADO:${expiry}`);
    console.log(`[${new Date().toISOString()}] ASIGNADO + PAUSADO → ${phone} (conv: ${conv.id})`);
  }

  // Direction C: Juan assigned in ycloud, Supabase PAUSADO → keep in sync, nothing to do
  // (already handled above)
}

async function run() {
  console.log(`NecoBot Sync arrancado. Intervalo: ${POLL_INTERVAL_MS / 1000}s`);
  while (true) {
    try { await poll(); }
    catch (err) { console.error(`[${new Date().toISOString()}] ERROR:`, err.message); }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

require('http').createServer((_, res) => res.end('ok')).listen(3000);
run();

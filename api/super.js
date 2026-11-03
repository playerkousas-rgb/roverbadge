// GAS → Vercel 短效登入票據驗證。僅回傳判定，不回傳密碼或 GAS session。
import { openSuper, equalSecret } from './_super.js';
import { getTrustedTroop, backendMatches } from './_registry.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false });
  }
  try {
    let body = req.body;
    if (!body) {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) return res.status(413).json({ ok: false });
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks).toString();
    }
    if (typeof body === 'string') body = JSON.parse(body);
    const ticket = openSuper('login', body?.ticket);
    const troop = ticket && getTrustedTroop(ticket.troopId);
    // /exec 正規化（GS 5.3.0）：GAS 回報嘅部署網址接受「登記字串」或「正規化字串」兩種等價形式
    //（Workspace 帳戶回報 /a/macros/<域名>/s/<id>/exec，與登記用嘅 /macros/s/<id>/exec 指向同一部署），
    // 一律正規化後再比對；改一個 byte、換部署、換 KEY 仍然全部拒絕（fail-closed 不變）。
    const reportedBackend = !!(troop && (backendMatches(troop.backend, body.backend) ||
      backendMatches(troop.backend, body.backendCanonical)));
    // 票據仍然綁死「登記字串」：ticket.backend 由 proxy 以 troop.backend 簽發，唔接受請求自帶值。
    const ok = !!(troop && equalSecret(body.apikey, troop.apikey) &&
      equalSecret(ticket.apikey, troop.apikey) && reportedBackend && ticket.backend === troop.backend);
    return res.status(ok ? 200 : 401).json({ ok });
  } catch { return res.status(400).json({ ok: false }); }
}

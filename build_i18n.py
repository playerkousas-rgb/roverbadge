# -*- coding: utf-8 -*-
import re, json, sys

path = '/home/user/roverbadge/index.html'
src = open(path, encoding='utf-8').read()

# ---------- 1. Build LANG_DICT from TSV ----------
dict_items = []
seen = set()
with open('/home/user/roverbadge/i18n_dict.tsv', encoding='utf-8') as f:
    for line in f:
        line = line.rstrip('\n')
        if not line.strip() or '\t' not in line: continue
        k, v = line.split('\t', 1)
        if k in seen: continue
        seen.add(k)
        dict_items.append((k, v))

def js_str(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'

lines = []
lines.append('/* ================== i18n (English mode) ================== */')
lines.append("const UI_LANG=(function(){ try{ return localStorage.getItem('roverbadge_lang')||'zh'; }catch(e){ return 'zh'; } })();")
lines.append('const LANG_DICT={')
for k, v in dict_items:
    lines.append('  ' + js_str(k) + ': ' + js_str(v) + ',')
lines.append('};')
lines.append("const LANG_KEYS=Object.keys(LANG_DICT).sort(function(a,b){ return b.length-a.length; });")
lines.append("const LANG_RE=new RegExp('('+LANG_KEYS.map(function(k){ return k.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&'); }).join('|')+')','g');")
lines.append("function tr(s){ if(UI_LANG!=='en'||!s||typeof s!=='string') return s; return s.replace(LANG_RE,function(m){ return LANG_DICT[m]!==undefined?LANG_DICT[m]:m; }); }")
lines.append("function isEn(){ return UI_LANG==='en'; }")
lines.append("function itemsDataUrl(){ return UI_LANG==='en'?'data/items_en.json':'data/items.json'; }")
lines.append("function setUILang(l){ try{ localStorage.setItem('roverbadge_lang',l); }catch(e){} location.reload(); }")
lines.append("function translateTextNode(node){ if(UI_LANG!=='en'||!node) return; const v=node.nodeValue; if(!v||!v.trim()) return; const t=tr(v); if(t!==v) node.nodeValue=t; }")
lines.append("function translateAttrs(el){ if(UI_LANG!=='en'||!el||el.nodeType!==1) return; ['placeholder','title','aria-label','alt'].forEach(function(a){ if(el.hasAttribute(a)){ const v=el.getAttribute(a); if(v){ const t=tr(v); if(t!==v) el.setAttribute(a,t); } } }); }")
lines.append("function translateNode(node){ if(!node) return; if(node.nodeType===3){ translateTextNode(node); return; } if(node.nodeType!==1) return; const tag=(node.tagName||'').toLowerCase(); if(tag==='script'||tag==='style'||tag==='textarea') return; translateAttrs(node); if(tag==='input'||tag==='select') return; let n=node.firstChild; while(n){ const nx=n.nextSibling; translateNode(n); n=nx; } }")
lines.append("function translatePage(root){ if(!root) return; translateNode(root); }")
lines.append("let __i18nApplying=false;")
lines.append("function startI18nObserver(){ if(typeof MutationObserver==='undefined') return; const obs=new MutationObserver(function(muts){ if(__i18nApplying) return; __i18nApplying=true; try{ for(let i=0;i<muts.length;i++){ const m=muts[i]; if(m.type==='characterData'){ const p=m.target.parentNode; if(p && !/^(script|style|textarea|code)$/i.test(p.tagName||'')) translateTextNode(m.target); } else if(m.type==='attributes'){ translateAttrs(m.target); } else if(m.type==='childList'){ for(let j=0;j<m.addedNodes.length;j++) translateNode(m.addedNodes[j]); } } }finally{ __i18nApplying=false; } }); obs.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['placeholder','title','aria-label','alt']}); return obs; }")
i18n_block = '\n'.join(lines)

anchor = '<script>\n/* ================== 全局狀態 ================== */'
assert src.count(anchor) == 1, 'anchor1 count=%d' % src.count(anchor)
src = src.replace(anchor, '<script>\n' + i18n_block + '\n\n/* ================== 全局狀態 ================== */')

# ---------- 2. DOMContentLoaded: apply English mode + observer + toggle labels ----------
anchor2 = "document.addEventListener('DOMContentLoaded',()=>{\n  // 嵌入模式樣式"
assert src.count(anchor2) == 1, 'anchor2 count=%d' % src.count(anchor2)
init_js = """document.addEventListener('DOMContentLoaded',()=>{
  // i18n: apply English mode
  if(UI_LANG==='en'){
    document.documentElement.lang='en';
    document.title=tr(document.title);
    translatePage(document.body);
  }
  startI18nObserver();
  document.querySelectorAll('.lang-toggle').forEach(function(btn){ btn.textContent=(UI_LANG==='en')?'🌐 中文':'🌐 English'; });
  // 嵌入模式樣式"""
src = src.replace(anchor2, init_js, 1)

# ---------- 3. showToast uses tr ----------
anchor3 = "const e=document.getElementById('toast'); e.textContent=m;"
assert src.count(anchor3) == 1, 'anchor3 count=%d' % src.count(anchor3)
src = src.replace(anchor3, "const e=document.getElementById('toast'); e.textContent=tr(m);")

# ---------- 4. items.json -> itemsDataUrl() ----------
old_fetch = "fetch('data/items.json')"
n = src.count(old_fetch)
print('fetch data/items.json occurrences:', n)
src = src.replace(old_fetch, 'fetch(itemsDataUrl())')

# ---------- 5. confirm/prompt wrap with tr ----------
def wrap(src, old, new):
    c = src.count(old)
    assert c >= 1, 'MISSING: ' + old[:60]
    return src.replace(old, new, 1), c

pairs = [
 ("confirm(`確定停用此帳號 (", "confirm(tr(`確定停用此帳號 ("),
 ("confirm(`確定重設 ${ymis} 的密碼？", "confirm(tr(`確定重設 ${ymis} 的密碼？"),
 ("confirm(`確定捨棄 ${pendingChanges.length} 項未保存變更？`)", "confirm(tr(`確定捨棄 ${pendingChanges.length} 項未保存變更？`))"),
 ("confirm(`確定將 ${itemChecks.length} 個項目標記為完成", "confirm(tr(`確定將 ${itemChecks.length} 個項目標記為完成"),
 ("confirm(`確定要${decision==='approved'?'批准':'拒絕'}此申請？`)", "confirm(tr(`確定要${decision==='approved'?'批准':'拒絕'}此申請？`))"),
 ("confirm(`確定批量批准 ${checks.length} 項？`)", "confirm(tr(`確定批量批准 ${checks.length} 項？`))"),
 ("confirm(`確定刪除「${r?r.title:recordId}」？此操作不能復原。`)", "confirm(tr(`確定刪除「${r?r.title:recordId}」？此操作不能復原。`))"),
 ("confirm(`確定要${dec==='approved'?'批准':'拒絕'}嗎？`)", "confirm(tr(`確定要${decision==='approved'?'批准':'拒絕'}嗎？`))"),
 ("prompt('成員 YMIS（10位數字）')", "prompt(tr('成員 YMIS（10位數字）'))"),
 ("prompt('成員姓名')", "prompt(tr('成員姓名'))"),
 ("prompt('備註（可留空）','')", "prompt(tr('備註（可留空）'),'')"),
 ("prompt('聯絡電郵（可留空）','')", "prompt(tr('聯絡電郵（可留空）'),'')"),
 ("prompt('角色：member / exec_committee / branch_leader / group_leader / admin','member')", "prompt(tr('角色：member / exec_committee / branch_leader / group_leader / admin'),'member')"),
 ("prompt('密碼（留空＝只加成員，無登入）','')", "prompt(tr('密碼（留空＝只加成員，無登入）'),'')"),
 ("prompt('備註（留空代表未填）', currentSquad||'')", "prompt(tr('備註（留空代表未填）'), currentSquad||'')"),
 ("confirm('是否可勾選進度？')", "confirm(tr('是否可勾選進度？'))"),
]
for old, new in pairs:
    src, c = wrap(src, old, new)
    print('wrapped ok:', c, old[:40])

# ---------- 6. Language toggle buttons ----------
welcome_anchor = "      <button data-tab=\"guide\" onclick=\"showWelcomeTab('guide', this)\">📖 使用教學</button>\n      <!-- changelog hidden for production -->\n    </div>"
assert src.count(welcome_anchor) == 1, 'welcome anchor'
src = src.replace(welcome_anchor, "      <button data-tab=\"guide\" onclick=\"showWelcomeTab('guide', this)\">📖 使用教學</button>\n      <!-- changelog hidden for production -->\n    </div>\n    <button class=\"lang-toggle\" onclick=\"setUILang(UI_LANG==='en'?'zh':'en')\">🌐 English</button>")

main_anchor = "      <span class=\"user-chip\" id=\"userInfo\">—</span>\n      <button class=\"btn btn-sm btn-secondary\" onclick=\"doLogout()\">登出</button>"
assert src.count(main_anchor) == 1, 'main anchor'
src = src.replace(main_anchor, "      <span class=\"user-chip\" id=\"userInfo\">—</span>\n      <button class=\"lang-toggle\" onclick=\"setUILang(UI_LANG==='en'?'zh':'en')\">🌐 English</button>\n      <button class=\"btn btn-sm btn-secondary\" onclick=\"doLogout()\">登出</button>")

# CSS
css_anchor = ".btn-outline:hover{background:var(--maroon);color:#fff}"
assert src.count(css_anchor) == 1, 'css anchor'
src = src.replace(css_anchor, css_anchor + "\n.lang-toggle{position:absolute;top:10px;right:10px;padding:5px 12px;border:1.5px solid rgba(255,255,255,0.6);border-radius:999px;background:rgba(255,255,255,0.12);color:#fff;font-size:11px;font-weight:700;cursor:pointer;transition:.2s;z-index:5}\n.lang-toggle:hover{background:rgba(255,255,255,0.25);transform:translateY(-1px)}\n.main-app-header .lang-toggle{position:static;border-color:rgba(255,255,255,0.5);background:rgba(255,255,255,0.12);color:#fff}")

# ---------- 7. EMBEDDED_GUIDES English ----------
guides_en = """
  member_en: `<h2>👤 Member Guide</h2>
  <blockquote>You only need to care about your own progress; other features are handled by leaders</blockquote>
  <h3>After logging in you will see</h3>
  <ul>
    <li><b>📊 My Progress</b>: shows your own completion by default. Green progress bar = completed. Click a badge to expand; use ⓘ on the right to view the assessment details. You <b>cannot tick items directly</b> — press "📝 Request" instead.</li>
    <li><b>⭐ Other Badges</b>: merged into the dashed card at the bottom of My Progress.</li>
    <li><b>📝 Pending</b>: check whether your requests have been approved.</li>
    <li><b>🖨️ Print Forms</b>: auto-fill PT/21 and PT/22 dates, then print the official format.</li>
    <li><b>📚 Library</b>: Safe from Harm course links and the Training Scheme.</li>
  </ul>
  <h3>How to request completion?</h3>
  <ol><li>Find the item in My Progress</li><li>Press 📝 Request</li><li>Pick the date + evidence</li><li>Submit; the leader sees it in Pending</li><li>After approval, your progress updates</li></ol>
  <h4>Why can't I see other members?</h4>
  <p>Privacy is on by default — members only see themselves. The Group Scout Leader can enable "Allow members to view each other's progress" in User Management → System Settings.</p>`,

  exec_en: `<h2>🎖️ Crew Management Committee Guide (CMC)</h2>
  <blockquote>The self-governing body of the Rover Scout Crew is the "Crew Management Committee", responsible for the internal structure, organisation, programme and administration of the Crew</blockquote>
  <ul>
    <li>All member functions</li>
    <li><b>Can tick progress</b> (if authorised); default: Membership Badge + Activities segments (no need to tick each sub-item) + Other badges individually</li>
    <li>Can select other members in My Progress to view their records</li>
    <li>Can use batch ticking in the Group Overview (if authorised)</li>
    <li>Can approve requests in Pending (if authorised)</li>
  </ul>
  <h3>How to tick for a member?</h3>
  <ol><li>Select the member in My Progress</li><li>Find the item, tick it and adjust the date</li><li>Confirm writing at the bottom</li></ol>`,

  leader_en: `<h2>👨‍💼 Leader Guide</h2>
  <blockquote>You have full permissions</blockquote>
  <h3>1. My Progress</h3><ul><li>Select any member to see all records</li><li>Tick directly + set dates; changes are saved offline until you confirm writing</li></ul>
  <h3>2. Group Overview</h3><ul><li>Cards give an instant view of the Membership Badge ✓</li><li>Table matrix shows up to 30 columns</li><li>🚀 Camp batch: select members + items → mark → stage → confirm writing</li><li>Sub-tabs: by member / by item</li></ul>
  <h3>3. Approval Centre</h3><ul><li>🏅 Badge approvals + 👤 user applications merged</li></ul>
  <h3>4. Print Forms</h3><p>Auto-filled official PT/21 / PT/22 format</p>
  <h3>5. User Management</h3><ul><li>Change members to CMC</li><li>⚙️ Permissions: leaders default to all; members none; CMC defaults to L1 + Activities segments + OTHER</li><li>Set each member's assessable scope individually</li></ul>
  <h3>6. System Settings</h3><p>Allow members to view each other's progress: off by default; the Group Scout Leader can enable it</p>`
};"""

guide_anchor = "  <h3>6. 系統設定</h3><p>允許成員互相查看進度：預設關，團長可開</p>`\n};"
assert src.count(guide_anchor) == 1, 'guide anchor'
src = src.replace(guide_anchor, "  <h3>6. 系統設定</h3><p>允許成員互相查看進度：預設關，團長可開</p>`" + guides_en)

# pick EN guide in renderHelpTab and switchHelpRole
g1_old = "${EMBEDDED_GUIDES[key]||EMBEDDED_GUIDES.member}"
g1_new = "${EMBEDDED_GUIDES[isEn()?key+'_en':key]||EMBEDDED_GUIDES[isEn()?'member_en':'member']}"
n = src.count(g1_old)
print('guide pick sites:', n)
src = src.replace(g1_old, g1_new)

# ---------- save ----------
open(path, 'w', encoding='utf-8').write(src)
print('DONE. injected i18n block with', len(dict_items), 'dictionary entries')

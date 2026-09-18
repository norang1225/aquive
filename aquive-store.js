/* ══════════════════════════════════════════════════════════════════
   AQUIVE 계정 · 기록 저장소  (card.html / aquarium.html 공용)

   ▸ 로그인: "이름 + 비밀번호"만 입력. 처음 쓰는 이름이면 자동 가입, 이미 있으면 로그인.
   ▸ 저장 위치
       - FIREBASE_CONFIG 를 채우면  → Firebase(Authentication + Firestore)에 저장
       - 비어 있으면(지금)          → 이 브라우저 localStorage에만 저장 (화면 확인용 테스트 모드)
   ▸ 기록하는 것 (users/{uid}.progress)
       visits / depth      수심(방문 횟수 × 10m, 최대 4000m)
       collected           도감에 채운 물고기 id (채운 순서대로)
       lastTankId          마지막으로 본 수조   → "이어서"
       visitedTankIds      다녀간 수조 목록     → 탐험 범위

   ▸ 사용법
       card.html      AquiveStore.resume() / enter(name, pw) / signOut()
       aquarium.html  AquiveSync.noteTank(id) / AquiveSync.push()
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ══ 설정 ══════════════════════════════════════════════════════════
  // Firebase 콘솔 → 프로젝트 설정 → 내 앱(웹) 의 firebaseConfig 객체를 그대로 붙여넣으면 Firebase 모드가 켜진다.
  //   예) { apiKey:'...', authDomain:'...', projectId:'...', appId:'...' }
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBEQhI6pSphJq3COEqVho9ntR5c_LEgk-0",
    authDomain: "aquive-a7080.firebaseapp.com",
    projectId: "aquive-a7080",
    storageBucket: "aquive-a7080.firebasestorage.app",
    messagingSenderId: "936957683827",
    appId: "1:936957683827:web:54c74e657970144da92206"
  };
  const FIREBASE_SDK    = 'https://www.gstatic.com/firebasejs/10.14.1';
  const EMAIL_DOMAIN    = 'aquive.invalid';   // 이름을 이메일 형태로 바꿀 때 쓰는 가짜 도메인 (실제 메일은 발송되지 않음)
  const CONTRACT_VERSION = '2026-09-v1';      // 계약서 문구를 바꾸면 올린다
  const DEPTH_PER_VISIT = 10, MAX_DEPTH = 4000;
  const PUSH_DELAY = 1200;                    // 기록 저장 지연(ms) — 잦은 저장 방지

  // 수조 페이지가 이미 쓰는 localStorage 키 + 계정용 키
  const K = {
    depth: 'aquive_depth',               // {visits, depth}
    dex:   'aquive_collected_fish',      // [fishId, ...]
    prog:  'aquive_progress',            // {lastTankId, visitedTankIds, updatedAt}
    owner: 'aquive_owner_uid',           // 이 브라우저의 기록이 누구 것인지
    lAccounts: 'aquive_local_accounts',  // (테스트 모드) 계정 목록
    lSession:  'aquive_local_session',   // (테스트 모드) 로그인 상태
  };

  // ══ 유틸 ══════════════════════════════════════════════════════════
  const jget = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  class AquiveError extends Error {
    constructor(code) { super(code); this.name = 'AquiveError'; this.code = code; }
  }

  const NAME_RE = /^[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9]{1,7}$/;
  const normName  = n => String(n || '').normalize('NFC').trim().toLowerCase();      // 대소문자 구분 없이 같은 이름으로 취급
  const toHex     = s => Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('');
  const nameToEmail = n => 'n' + toHex(normName(n)) + '@' + EMAIL_DOMAIN;             // 한글 이름도 안전한 이메일 형태로

  function validate(name, pw) {
    if (!NAME_RE.test(String(name || '').trim())) throw new AquiveError('invalid-name');
    if (String(pw || '').length < 6) throw new AquiveError('weak-password');           // Firebase 최소 6자
  }

  // ══ 기록(progress) ═════════════════════════════════════════════════
  function normProgress(p) {
    p = p || {};
    const visits = Math.max(0, Math.min(MAX_DEPTH / DEPTH_PER_VISIT, p.visits | 0));
    return {
      visits,
      depth: visits * DEPTH_PER_VISIT,
      collected: Array.isArray(p.collected) ? p.collected : [],
      lastTankId: Number.isFinite(p.lastTankId) ? p.lastTankId : 0,
      visitedTankIds: Array.isArray(p.visitedTankIds) ? p.visitedTankIds : [],
      updatedAt: p.updatedAt || 0,
    };
  }
  function readProgress() {
    const d = jget(K.depth, {});
    const pr = jget(K.prog, {});
    return normProgress({ visits: d.visits, collected: jget(K.dex, []), lastTankId: pr.lastTankId, visitedTankIds: pr.visitedTankIds, updatedAt: pr.updatedAt });
  }
  function writeProgress(p) {
    p = normProgress(p);
    jset(K.depth, { visits: p.visits, depth: p.depth });
    jset(K.dex, p.collected);
    jset(K.prog, { lastTankId: p.lastTankId, visitedTankIds: p.visitedTankIds, updatedAt: p.updatedAt });
  }
  function clearProgress() { [K.depth, K.dex, K.prog, K.owner].forEach(k => localStorage.removeItem(k)); }
  // 두 기록을 합침: 수심은 큰 쪽, 도감·탐험은 합집합, 마지막 위치는 더 최근 것
  function mergeProgress(a, b) {
    a = normProgress(a); b = normProgress(b);
    const newer = b.updatedAt >= a.updatedAt ? b : a;
    return normProgress({
      visits: Math.max(a.visits, b.visits),
      collected: Array.from(new Set([...a.collected, ...b.collected])),
      lastTankId: newer.lastTankId,
      visitedTankIds: Array.from(new Set([...a.visitedTankIds, ...b.visitedTankIds])),
      updatedAt: Math.max(a.updatedAt, b.updatedAt),
    });
  }
  function newProfile(name) {
    const now = new Date().toISOString();
    return { nickname: String(name).trim(), avatarId: null, contractVersion: CONTRACT_VERSION, agreedAt: now, createdAt: now, progress: null };
  }

  // 서버 기록을 이 브라우저의 기록(localStorage)에 반영. 같은 브라우저를 다른 사람이 쓰더라도 기록이 섞이지 않게 한다.
  function adopt(uid, serverProgress, isNew) {
    const owner = localStorage.getItem(K.owner);
    let next;
    if (isNew)               next = (owner && owner !== uid) ? normProgress(null) : readProgress(); // 새 계정: 남의 기록은 버리고, 주인 없는 기록은 이어받음
    else if (owner === uid)  next = mergeProgress(serverProgress, readProgress());                    // 같은 사람: 합치기
    else                     next = normProgress(serverProgress);                                     // 다른 사람 기록이 남아 있었다면: 서버 기록으로 교체
    writeProgress(next);
    localStorage.setItem(K.owner, uid);
    return next;
  }

  // ══ 백엔드 1: 로컬 테스트 (Firebase 설정 전) ═══════════════════════
  async function hashPw(nk, pw) {
    const s = 'aquive:' + nk + ':' + pw;
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
    return 'x' + (h >>> 0).toString(16);
  }
  const localBackend = {
    mode: 'local',
    async init() {},
    async restore() {
      const s = localStorage.getItem(K.lSession); if (!s) return null;
      const acc = jget(K.lAccounts, {})[s]; return acc ? acc.uid : null;
    },
    async enter(name, pw) {
      const all = jget(K.lAccounts, {}), nk = normName(name), h = await hashPw(nk, pw);
      let acc = all[nk], isNew = false;
      if (acc) { if (acc.pwHash !== h) throw new AquiveError('wrong-password'); }
      else { isNew = true; acc = all[nk] = { uid: 'local_' + toHex(nk), pwHash: h, profile: newProfile(name) }; jset(K.lAccounts, all); }
      localStorage.setItem(K.lSession, nk);
      return { isNew, uid: acc.uid, profile: acc.profile };
    },
    async load(uid) { const a = Object.values(jget(K.lAccounts, {})).find(x => x.uid === uid); return a ? a.profile : null; },
    async save(uid, patch) {
      const all = jget(K.lAccounts, {}), k = Object.keys(all).find(x => all[x].uid === uid); if (!k) return;
      all[k].profile = { ...all[k].profile, ...patch }; jset(K.lAccounts, all);
    },
    async signOut() { localStorage.removeItem(K.lSession); },
  };

  // ══ 백엔드 2: Firebase ═════════════════════════════════════════════
  function mapFbError(e) {
    const c = (e && e.code) || '';
    if (c === 'auth/invalid-credential' || c === 'auth/wrong-password' || c === 'auth/user-not-found') return new AquiveError('wrong-password');
    if (c === 'auth/weak-password')          return new AquiveError('weak-password');
    if (c === 'auth/invalid-email')          return new AquiveError('invalid-name');
    if (c === 'auth/too-many-requests')      return new AquiveError('too-many');
    if (c === 'auth/network-request-failed') return new AquiveError('network');
    if (c === 'permission-denied' || c === 'auth/operation-not-allowed') return new AquiveError('config');
    console.warn('[AQUIVE] Firebase 오류', e);
    return new AquiveError('unknown');
  }
  const fbBackend = {
    mode: 'firebase',
    async init() {
      const [A, F, S] = await Promise.all([
        import(FIREBASE_SDK + '/firebase-app.js'),
        import(FIREBASE_SDK + '/firebase-auth.js'),
        import(FIREBASE_SDK + '/firebase-firestore.js'),
      ]);
      this.F = F; this.S = S;
      this.app  = A.initializeApp(FIREBASE_CONFIG);
      this.auth = F.getAuth(this.app);
      this.db   = S.getFirestore(this.app);
      // 이전에 로그인했다면 복원될 때까지 한 번 기다림
      await new Promise(res => { const un = F.onAuthStateChanged(this.auth, () => { un(); res(); }); });
    },
    async restore() { return this.auth.currentUser ? this.auth.currentUser.uid : null; },
    async enter(name, pw) {
      const email = nameToEmail(name);
      let cred, isNew = false;
      // 먼저 가입을 시도 → 이미 있는 이름이면 로그인으로 전환
      // (로그인부터 시도하면 "없는 이름"과 "틀린 비밀번호"를 Firebase가 구분해 주지 않는다)
      try { cred = await this.F.createUserWithEmailAndPassword(this.auth, email, pw); isNew = true; }
      catch (e) {
        if (e && e.code === 'auth/email-already-in-use') {
          try { cred = await this.F.signInWithEmailAndPassword(this.auth, email, pw); }
          catch (e2) { throw mapFbError(e2); }
        } else throw mapFbError(e);
      }
      const ref = this.S.doc(this.db, 'users', cred.user.uid);
      let profile = null;
      try {
        if (!isNew) { const snap = await this.S.getDoc(ref); profile = snap.exists() ? snap.data() : null; }
        if (!profile) { profile = newProfile(name); await this.S.setDoc(ref, profile); isNew = true; }   // 문서가 없으면 새로 만든다
      } catch (e) { throw mapFbError(e); }
      return { isNew, uid: cred.user.uid, profile };
    },
    async load(uid) { const snap = await this.S.getDoc(this.S.doc(this.db, 'users', uid)); return snap.exists() ? snap.data() : null; },
    async save(uid, patch) { await this.S.setDoc(this.S.doc(this.db, 'users', uid), patch, { merge: true }); },
    async signOut() { await this.F.signOut(this.auth); },
  };

  // ══ 공개 API ═══════════════════════════════════════════════════════
  const backend = FIREBASE_CONFIG ? fbBackend : localBackend;
  const ready = backend.init().then(() => true).catch(e => { console.warn('[AQUIVE] 저장소 초기화 실패', e); return false; });

  const AquiveStore = {
    mode: backend.mode,
    ready,
    CONTRACT_VERSION,
    readProgress,
    // 이미 로그인된 상태면 프로필(+기록)을 돌려주고, 아니면 null
    async resume() {
      if (!(await ready)) return null;
      const uid = await backend.restore(); if (!uid) return null;
      const profile = await backend.load(uid); if (!profile) return null;
      const progress = adopt(uid, profile.progress, false);
      backend.save(uid, { progress: { ...progress, updatedAt: Date.now() } }).catch(() => {});
      return { ...profile, progress };
    },
    // 이름 + 비밀번호 → 없으면 가입, 있으면 로그인.  성공: {isNew, profile}
    async enter(name, pw) {
      validate(name, pw);
      if (!(await ready)) throw new AquiveError('network');
      const r = await backend.enter(name, pw);
      const progress = adopt(r.uid, r.profile.progress, r.isNew);
      try { await backend.save(r.uid, { progress: { ...progress, updatedAt: Date.now() } }); } catch (e) { throw mapFbError(e); }
      return { isNew: r.isNew, profile: { ...r.profile, progress } };
    },
    async signOut() {
      await ready;
      try { await backend.signOut(); } catch (e) {}
      clearProgress();       // 같은 브라우저를 쓰는 다음 사람에게 기록이 남지 않도록
    },
  };

  // 수조 페이지에서 쓰는 기록 도우미
  let pushTimer = null;
  async function flush() {
    clearTimeout(pushTimer);
    try {
      if (!(await ready)) return;
      const uid = await backend.restore();
      if (!uid || localStorage.getItem(K.owner) !== uid) return;                // 로그인 안 했거나, 이 브라우저 기록이 다른 사람 것이면 저장 안 함
      await backend.save(uid, { progress: { ...readProgress(), updatedAt: Date.now() } });
    } catch (e) { console.warn('[AQUIVE] 기록 저장 실패', e); }
  }
  const AquiveSync = {
    push() { clearTimeout(pushTimer); pushTimer = setTimeout(flush, PUSH_DELAY); },   // 잦은 호출을 모아서 저장
    flush,
    // 수조를 볼 때마다 호출: 마지막 위치 + 탐험한 수조 기록
    noteTank(tankId) {
      const p = jget(K.prog, {}), v = new Set(p.visitedTankIds || []); v.add(tankId);
      jset(K.prog, { lastTankId: tankId, visitedTankIds: Array.from(v), updatedAt: Date.now() });
      AquiveSync.push();
    },
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  window.AquiveError = AquiveError;
  window.AquiveStore = AquiveStore;
  window.AquiveSync  = AquiveSync;
})();

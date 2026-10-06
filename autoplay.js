/* ============================================================
   《快乐小日子》自动玩 · 20 关随机顺序 · 无限循环（交付版 v1.2）
   ------------------------------------------------------------
   打开页面后按随机顺序连打 20 关，全程零人工点击（每轮洗牌）。
   每关通关回菜单选下一关，打完一轮自动开下一轮，无限循环。

   本文件由 probe/build_autoplay.js 自动生成，请勿直接修改：
     改流程 → 改 probe/autoplay_core.js
     改手势关 → 改 probe/expr_lvNplay.js；改计划表关 → 改 probe/plans/*.json
   ============================================================ */
/* ============================================================
   《快乐小日子》自动玩 · 20 关随机顺序 · 无限循环（核心代码）
   ------------------------------------------------------------
   原理：不改游戏源码，只调用游戏自己的接口 + 注入手势事件。
   行为：页面打开后按随机顺序连打 20 关（每轮洗牌，一轮内不重复）→
        每关通关后回菜单选下一关 → 打完一轮自动开下一轮，无限循环。
        全程零人工点击；想停就刷新页面或关掉标签页。
   结构：
     · 工具层：__HLD__（类名 / 场景查找，驱动脚本依赖）
     · 流程层：成功弹窗、失败弹窗、开场卡、菜单选关、关卡切换、卡死兜底
     · 驱动层：第 3~10 关 = 专用手势驱动（构建时逐字拼在文件尾部）；
              第 11~20 关 = 计划表驱动（pt.js 引擎 + plans/*.json 内嵌）；
              32068（惠灵顿牛排）= 原型补丁 + 反应式跟队驱动（两段式）；
              个别没有专用驱动的关卡仍用游戏自身 partAnim 播步骤动画兜底
   注意：交付文件 autoplay/autoplay.js 由 probe/build_autoplay.js 生成。
        改流程 → 改本文件；改单关 → 改 probe/expr_lvNplay.js 或计划表，然后重新构建。
   ============================================================ */
(function () {
  var W = window;
  if (W.__AUTOPLAY__ && W.__AUTOPLAY__.stop) { try { W.__AUTOPLAY__.stop(); } catch (e) {} }

  var AP = W.__AUTOPLAY__ = {
    version: '1.2',
    t0: Date.now(),
    log: [],
    drivers: {},
    done: false,
    loop: null
  };

  // ---------------- 日志 ----------------
  function log(msg, loud) {
    var s = ((Date.now() - AP.t0) / 1000).toFixed(1) + 's ' + msg;
    AP.log.push(s);
    if (AP.log.length > 1200) AP.log.splice(0, 600);
    if (loud) { try { console.log('[自动玩] ' + s); } catch (e) {} }
  }
  AP.logAdd = log;

  // ---------------- 1. 工具：类名 / 场景查找 ----------------
  function clsName(o) {
    try {
      if (!o) return '';
      if (o.__classname__) return o.__classname__;
      if (W.cc && cc.js && cc.js.getClassName) { var n = cc.js.getClassName(o); if (n) return n; }
      if (o.constructor && o.constructor.__classname__) return o.constructor.__classname__;
      return (o.constructor && o.constructor.name) || '';
    } catch (e) { return ''; }
  }
  function findAll(name) {
    var out = [];
    try {
      var scene = cc.director.getScene();
      (function walk(n) {
        if (!n) return;
        var comps = n._components || [];
        for (var i = 0; i < comps.length; i++) {
          var cnm = clsName(comps[i]);
          if (cnm === name || cnm.indexOf(name) >= 0) out.push(comps[i]);
        }
        var kids = n._children || [];
        for (var j = 0; j < kids.length; j++) walk(kids[j]);
      })(scene);
    } catch (e) {}
    return out;
  }
  function findNode(name, root) {
    var hit = null;
    (function rec(n) {
      if (!n || hit) return;
      if (n.name === name) { hit = n; return; }
      var ch = n._children || [];
      for (var j = 0; j < ch.length; j++) rec(ch[j]);
    })(root || (W.cc && cc.director.getScene()));
    return hit;
  }
  function walkTree(node, depth, lines) {
    node = node || (W.cc && cc.director && cc.director.getScene());
    if (!node) return ['(no scene)'];
    lines = lines || [];
    var pad = new Array((depth || 0) + 1).join('  ');
    var comps = [];
    try {
      var cs = node._components || [];
      for (var i = 0; i < cs.length; i++) comps.push(clsName(cs[i]));
    } catch (e) {}
    lines.push(pad + node.name + (node.activeInHierarchy ? '' : ' [hidden]') + (comps.length ? '  <' + comps.join(', ') + '>' : ''));
    if ((depth || 0) >= 8) return lines;
    var ch = node._children || [];
    for (var j = 0; j < ch.length; j++) walkTree(ch[j], (depth || 0) + 1, lines);
    return lines;
  }
  W.__HLD__ = {
    clsName: clsName,
    findAll: findAll,
    findNode: findNode,
    walk: walkTree,
    dumpTree: function () { return walkTree(null, 0, []); }
  };

  // ---------------- 2. 通用流程 ----------------
  var CFG = {
    levels: 20,           // 一轮 20 关（菜单 order 0~19；每轮顺序随机，打完自动洗牌开下一轮）
    partAnimGapMin: 1000, // 第 1-3 关：两步之间的间隔（拟人：1~3 秒随机）
    partAnimGapMax: 3000,
    levelCap: 360000,     // 单关超过 6 分钟还没通关 → 启用「跳过」兜底
    nextCool: 2500,       // 点过「下一关」后的冷却，等新关卡加载
    menuCool: 1600,       // 菜单点击冷却
    menuFirstWait: 1500   // 菜单出现后先等一会再点（让开场动画播完）
  };

  // 每轮洗牌：把 0..levels-1 随机排序（Fisher-Yates），一轮内每关只出一次
  function shuffled(n) {
    var a = [];
    for (var i = 0; i < n; i++) a.push(i);
    for (var j = a.length - 1; j > 0; j--) {
      var k = Math.floor(Math.random() * (j + 1));
      var t = a[j]; a[j] = a[k]; a[k] = t;
    }
    return a;
  }
  function orderStr(a) {
    var out = [];
    for (var i = 0; i < a.length; i++) out.push(a[i] + 1);
    return out.join('→');
  }

  var S = AP.state = {
    started: false,       // 是否已点过菜单进第 1 关
    completed: 0,         // 本轮已完成关数（打满 levels 就洗牌开下一轮）
    round: 1,             // 第几轮（无限循环）
    playOrder: shuffled(CFG.levels),   // 本轮随机顺序；每次打开页面/每轮重新洗牌
    curCls: '', curInst: null,
    driver: null,
    successComp: null, clickedNextFor: null,
    failComp: null,
    cardPlayFor: null, cardBackFor: null,
    menuAt: 0, menuSeenAt: 0, pageAt: 0,
    nextAt: 0, nextClickAt: 0, leftAt: 0, leftTries: 0,
    flipCount: 0,
    levelAt: 0, warned: false, skipDone: false,
    prePatched: false
  };

  function popupRoot() {
    try { return cc.find('Canvas').getChildByName('Node PopupContainer'); } catch (e) { return null; }
  }
  function activePopupChild(name) {
    var pc = popupRoot();
    if (!pc) return null;
    var hit = null;
    try {
      pc.children.forEach(function (n) { if (n.name === name && n.activeInHierarchy) hit = n; });
    } catch (e) {}
    return hit;
  }
  function findByClass(name) {
    var hit = null;
    findAll(name).forEach(function (c) { try { if (clsName(c) === name) hit = c; } catch (e) {} });
    return hit;
  }
  // 当前关卡组件 = 最后一个场景中激活的 Level-XXXXX
  function findCurrentLevel() {
    var all = findAll('Level');
    var cur = null;
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      try {
        var n = clsName(c);
        if (n.indexOf('Level-') !== 0) continue;
        if (!c.node || !c.node.activeInHierarchy) continue;
        cur = c;
      } catch (e) {}
    }
    return cur;
  }
  // 关卡外层的通用组件（带 skipHandle / successHandle）
  function findBaseLevel(fromNode) {
    try {
      var n = fromNode;
      var guard = 0;
      while (n && guard++ < 8) {
        var cs = n._components || [];
        for (var i = 0; i < cs.length; i++) {
          if (clsName(cs[i]) === 'Level') return cs[i];
        }
        n = n.parent;
      }
    } catch (e) {}
    var all = findAll('Level');
    for (var k = 0; k < all.length; k++) {
      try { if (clsName(all[k]) === 'Level' && all[k].node && all[k].node.activeInHierarchy) return all[k]; } catch (e) {}
    }
    return null;
  }
  function driverOf(cls) {
    var f = AP.drivers[cls];
    if (!f) return null;
    return f;
  }
  function disposeDriver() {
    try {
      var P = S.driver && S.driver.P;
      if (P) { P.done = true; if (P.timer) { clearInterval(P.timer); P.timer = null; } }
    } catch (e) {}
    S.driver = null;
  }

  // ---- 低关兜底：直接调用游戏自身的 partAnim（按步骤顺序播过关动画）----
  // 注：Level-32004（牛排）已换成专用手势驱动 probe/expr_lv3play.js
  var LOW_LEVELS = { 'Level-32295': 1, 'Level-31970': 1 };
  // 通用兜底：关卡池是动态抽取的，凡是带 partAnim+partInfo 的关卡都能用同一套驱动
  function canPartAnim(inst) {
    try {
      return typeof inst.partAnim === 'function' && inst.partInfo && Object.keys(inst.partInfo).length > 0;
    } catch (e) { return false; }
  }
  function installLowDriver(inst) {
    var P = W.__LOWP = { log: [], t0: Date.now(), done: false, lastMove: 0, lastK: null, stuck: 0, st3At: 0 };
    P.timer = setInterval(function () {
      if (P.done) return;
      try {
        var lv = inst;
        if (!lv || !lv.node || !lv.node.activeInHierarchy) return;
        // 等待操作的状态：第 1-3 关实测是 2（waitTouch）；
        // 若某个关卡把等待态记成 3，则「3 持续 3 秒仍无进展」时也视为等待。
        var stv = lv._state;
        var now = Date.now();
        var waiting = false;
        if (stv === 2) { P.st3At = 0; waiting = true; }
        else if (stv === 3) {
          if (!P.st3At) P.st3At = now;
          waiting = (now - P.st3At >= 3000);
        } else { P.st3At = 0; return; }
        if (!waiting) return;
        var keys = Object.keys(lv.partInfo || {}).map(Number).sort(function (a, b) { return a - b; });
        var k = null;
        for (var i = 0; i < keys.length; i++) {
          if (!lv.partInfo[keys[i]].completed) { k = keys[i]; break; }
        }
        if (k == null) return;
        if (now - P.lastMove < (P.gapNow || CFG.partAnimGapMin)) return;
        if (P.lastK === k) P.stuck++; else { P.lastK = k; P.stuck = 0; }
        if (P.stuck >= 16 && !P.skipped) {
          // 同一步连续 ~24 秒没有推进：这个关卡不适合 partAnim 直连，交给「跳过」兜底
          P.skipped = true;
          log('第 ' + k + ' 步连续尝试 ' + P.stuck + ' 次没进展，改用「跳过」兜底', true);
          trySkip(inst);
          P.done = true;
          if (P.timer) { clearInterval(P.timer); P.timer = null; }
          return;
        }
        var tip = '';
        try { tip = ((lv._touchList || [])[k - 1] || {}).tips || ''; } catch (e) {}
        var err = '';
        try { lv.partAnim(k); } catch (e) { err = ' ERR=' + e.message; }
        var ok = false;
        try { ok = !!(lv.partInfo[k] && lv.partInfo[k].completed); } catch (e) {}
        P.log.push(((now - P.t0) / 1000).toFixed(1) + 's 第' + k + '步 completed=' + ok + err + (tip ? ' | ' + tip : ''));
        if (P.log.length > 1500) P.log.splice(0, 700);
        if (P.stuck === 4) log('第 ' + k + ' 步重复尝试中（第 1-3 关）');
        P.lastMove = now;
        P.gapNow = CFG.partAnimGapMin + Math.random() * (CFG.partAnimGapMax - CFG.partAnimGapMin);   // 拟人：下一步之间停 1~3 秒随机
      } catch (e) {}
    }, 300);
    return P;
  }

  function installDriver(cls, inst) {
    disposeDriver();
    // 优先级：白名单低关(partAnim) → 专用手势驱动（真触摸，录屏观感最好）→ 通用 partAnim 兜底
    if (LOW_LEVELS[cls]) {
      var P = installLowDriver(inst);
      S.driver = { cls: cls, P: P, kind: 'partAnim' };
      log('装载驱动 ' + cls + '（步骤动画直连）');
      return true;
    }
    var f = driverOf(cls);
    if (!f && canPartAnim(inst)) {
      var P0 = installLowDriver(inst);
      S.driver = { cls: cls, P: P0, kind: 'partAnim' };
      log('装载驱动 ' + cls + '（步骤动画直连·通用兜底）');
      return true;
    }
    if (!f) { log('没有 ' + cls + ' 的驱动，跳过', true); return false; }
    var ret = '', name = DRIVER_G[cls], P2 = null;
    try { ret = f() || ''; } catch (e) { ret = '装载出错：' + e.message; log('驱动装载出错 ' + cls + '：' + e.message, true); }
    if (name) P2 = W[name];
    S.driver = { cls: cls, P: P2, kind: 'gesture' };
    log('装载驱动 ' + cls + ' → ' + String(ret).slice(0, 120));
    return true;
  }
  var DRIVER_G = {
    'Level-32004': '__L3P',
    'Level-32002': '__L4P',
    'Level-31969': '__L5P',
    'Level-31957': '__L6P',
    'Level-31968': '__L7P',
    'Level-32005': '__L8P',
    'Level-31935': '__L9P',
    'Level-32296': '__L10P',
    // 第 11~20 关：计划表驱动共用同一个引擎对象 __PT__
    'Level-32003': '__PT__',
    'Level-31956': '__PT__',
    'Level-32001': '__PT__',
    'Level-32016': '__PT__',
    'Level-32065': '__PT__',
    'Level-32008': '__PT__',
    'Level-32006': '__PT__',
    'Level-32120': '__PT__',
    'Level-32069': '__PT__',
    'Level-32068': '__L68P'
  };

  // ---- 卡死兜底：调用游戏自己的「跳过」（等于立刻通关）----
  function trySkip(inst) {
    try {
      var base = findBaseLevel(inst && inst.node);
      if (base && typeof base.skipHandle === 'function') {
        base.skipHandle();
        return true;
      }
    } catch (e) { log('跳过兜底出错：' + e.message); }
    return false;
  }

  // ---- 菜单选关 ----
  function menuItems() {
    var out = [];
    findAll('MenusItem').forEach(function (x) {
      try { if (x.node && x.node.activeInHierarchy && typeof x._order === 'number') out.push(x); } catch (e) {}
    });
    return out;
  }
  function pageMenu(dir) {
    var m = null;
    findAll('Menus').forEach(function (x) { try { if (clsName(x) === 'Menus') m = x; } catch (e) {} });
    if (!m) return false;
    if (m._moving && Date.now() - S.pageAt < 3000) return false;   // 翻页动画还没停，稍后再翻
    if (Date.now() - S.pageAt < 900) return false;
    S.pageAt = Date.now();
    try {
      if (dir < 0 && typeof m.clickPrevHandle === 'function') { m.clickPrevHandle(); log('菜单翻页 ←'); return true; }
      if (typeof m.clickNextHandle === 'function') { m.clickNextHandle(); log('菜单翻页 →'); return true; }
    } catch (e) { return false; }
    return false;
  }
  function tryMenuStart() {
    var items = menuItems();
    if (!items.length) return;
    if (!S.menuSeenAt) S.menuSeenAt = Date.now();
    if (Date.now() - S.menuSeenAt < CFG.menuFirstWait) return;
    var want = S.playOrder[S.completed];          // 本轮随机顺序里的下一关（菜单 order 从 0 起）
    if (S.completed >= CFG.levels) return;        // 保险：正常流程里 completed 一直在 0..9
    var now = Date.now();
    if (now - S.menuAt < CFG.menuCool) return;
    var it = null;
    var minO = Infinity, maxO = -Infinity;
    items.forEach(function (x) {
      try {
        if (x._order === want) it = x;
        if (x._order >= 0) { if (x._order < minO) minO = x._order; if (x._order > maxO) maxO = x._order; }
      } catch (e) {}
    });
    if (!it) {
      // 目标不在当前页：目标比当前页靠前就往前翻，否则往后翻（打开时能自动回第一页找第 1 关）
      var dir = (want < minO) ? -1 : 1;
      pageMenu(dir);
      S.flipCount++;
      if (S.flipCount % 25 === 0) log('菜单已翻 ' + S.flipCount + ' 次还没找到第 ' + (want + 1) + ' 关', true);
      return;
    }
    S.flipCount = 0;
    S.menuAt = now;
    S.started = true;
    log('菜单：进入第 ' + (want + 1) + ' 关（order=' + want + '）', true);
    try { it.clickPlayHandle(); } catch (e) { log('菜单点击出错：' + e.message); }
  }

  // ---------------- 3. 主循环 ----------------
  function step() {
    if (AP.done) return;
    if (!W.cc || !cc.director || !cc.director.getScene()) return;

    // (0) 关卡前预处理：必须在进关前打好的原型补丁（32068 的起手手势依赖它）
    if (!S.prePatched && AP.prepatch) {
      try { if (AP.prepatch()) S.prePatched = true; } catch (e) { }
    }

    // (1) 通关弹窗 → 回菜单选下一关（本轮随机顺序）；打满一轮立即洗牌开下一轮
    var sc = activePopupChild('Success');
    if (sc) {
      var comp = findByClass('Success');
      if (comp) {
        if (S.successComp !== comp) {
          S.successComp = comp;
          S.nextClickAt = 0;
          S.leftAt = 0;
          S.leftTries = 0;
          S.completed++;
          log('第 ' + S.round + ' 轮 · 第 ' + S.completed + ' 关通关（' + (S.curCls || '?') + '）', true);
          disposeDriver();
          if (S.completed >= CFG.levels) {
            var justPlayed = S.playOrder[S.playOrder.length - 1];   // 新一轮第一关避开刚打完的这关
            do { S.playOrder = shuffled(CFG.levels); } while (S.playOrder[0] === justPlayed);
            S.round++;
            S.completed = 0;
            log('第 ' + (S.round - 1) + ' 轮打完 → 第 ' + S.round + ' 轮随机顺序：' + orderStr(S.playOrder), true);
          }
        }
        if (S.clickedNextFor !== comp) {
          if (!S.nextClickAt) S.nextClickAt = Date.now() + 1200 + Math.random() * 1500;   // 拟人：看完结算停 1~3 秒再回菜单
          var can = false;
          try { can = comp._canClick && !comp._waitTimer && !comp._isClickNext && !comp._isClickHome; } catch (e) {}
          if (can && Date.now() >= S.nextClickAt) {
            S.clickedNextFor = comp;
            S.leftAt = Date.now();
            S.leftTries = 1;
            S.nextAt = Date.now();
            S.menuSeenAt = 0;   // 回菜单后重新等待开场时间，再选下一关
            log('回菜单 → 下一关＝第 ' + (S.playOrder[S.completed] + 1) + ' 关（第 ' + S.round + ' 轮 · ' + (S.completed + 1) + '/' + CFG.levels + '）');
            try { comp.clickHomeHandle(null); } catch (e) { log('回菜单点击出错：' + e.message); }
          }
        } else if (S.leftAt) {
          var waited = Date.now() - S.leftAt;
          if (waited > 20000 && S.leftTries < 3) {
            S.leftTries = 3;
            log('回菜单后 20 秒还停在结算，改用「下一关」保连播', true);
            try { comp.clickNextHandle(null); } catch (e) { log('「下一关」点击出错：' + e.message); }
          } else if (waited > 8000 && S.leftTries < 2) {
            S.leftTries = 2;
            log('回菜单后 8 秒没反应，重试一次');
            try { comp.clickHomeHandle(null); } catch (e) {}
          }
        }
      }
      return;
    }

    // (2) 失败弹窗 → 自动重开本关
    var fl = activePopupChild('Fail');
    if (fl) {
      var fc = findByClass('Fail');
      if (fc && S.failComp !== fc) {
        S.failComp = fc;
        disposeDriver();
        S.levelAt = Date.now(); S.warned = false; S.skipDone = false;
        log('本关失败，自动重开', true);
        setTimeout(function () { try { fc.clickAgainHandle(); } catch (e) { log('重开出错：' + e.message); } }, 700);
      }
      return;
    }

    // (3) 开场卡：UnlockMenu（解锁/进入卡）、ReadyMenu（准备卡）
    var um = activePopupChild('UnlockMenu');
    if (um) {
      var umc = findByClass('UnlockMenu');
      if (umc && S.cardPlayFor !== umc) {
        S.cardPlayFor = umc;
        log('开场卡：点「进入游戏」');
        setTimeout(function () { try { umc.clickPlayHandle(); } catch (e) { log('开场卡出错：' + e.message); } }, 400);
      }
      return;
    }
    var rm = activePopupChild('ReadyMenu');
    if (rm) {
      var rmc = findByClass('ReadyMenu');
      if (rmc && S.cardBackFor !== rmc) {
        S.cardBackFor = rmc;
        log('准备卡：点「开始」');
        setTimeout(function () { try { rmc.clickBackHandle(); } catch (e) { log('准备卡出错：' + e.message); } }, 400);
      }
      return;
    }

    // (4) 关卡中 → 对应驱动干活
    var lv = findCurrentLevel();
    if (lv) {
      var cls = clsName(lv);
      if (S.curInst !== lv || S.curCls !== cls) {
        S.curInst = lv;
        S.curCls = cls;
        S.levelAt = Date.now();
        S.warned = false;
        S.skipDone = false;
        log('开始关卡 ' + cls, true);
        installDriver(cls, lv);
      }
      var el = Date.now() - S.levelAt;
      if (!S.driver && !S.skipDone && el > 30000) {
        // 完全没有可用驱动（既没有手势驱动、也没有 partAnim）：不必空等 6 分钟，直接跳过
        S.skipDone = true;
        log('本关没有可用驱动，' + Math.round(el / 1000) + 's 后启用「跳过」兜底', true);
        trySkip(lv);
      }
      if (!S.warned && el > 180000) {
        S.warned = true;
        log('本关耗时较长（' + Math.round(el / 1000) + 's），继续驱动', true);
      }
      if (!S.skipDone && el > CFG.levelCap) {
        S.skipDone = true;
        log('本关 ' + Math.round(el / 1000) + 's 未通关，启用「跳过」兜底', true);
        trySkip(lv);
      }
      return;
    }

    // (5) 不在关卡里 → 菜单选关（刚点过「下一关」时留加载时间）
    if (Date.now() - S.nextAt < CFG.nextCool) return;
    tryMenuStart();
  }
  AP.step = step;

  AP.boot = function () {
    if (AP.loop) return 'already booted';
    AP.loop = setInterval(function () {
      try { step(); } catch (e) { log('主循环异常：' + e.message); }
    }, 250);
    log('自动玩已就绪：第 1 轮随机顺序 ' + orderStr(S.playOrder) + '（20 关一轮，打完自动洗牌无限循环；想停就刷新页面）', true);
    return 'autoplay booted';
  };
  AP.stop = function () {
    try { if (AP.loop) clearInterval(AP.loop); } catch (e) {}
    AP.loop = null;
    disposeDriver();
    AP.done = true;
    return 'stopped';
  };
  return AP;
})();


/* ====== 关卡驱动 ======
   手势驱动（第 3~10 关）：函数体逐字来自 probe/expr_lv*play.js；
   计划表驱动（第 11~20 关）：pt.js 的 HELPERS 引擎 + plans/*.json 逐字内嵌；
   32068：expr_lv68play.js 两段式（原型补丁 + 反应式跟队），另挂 AP.prepatch 预装。
   ============================================================ */
(function () {
  var AP = window.__AUTOPLAY__;
  if (!AP) { return; }
  var W = window;

  /* ---- L3  牛排（Level-32004，源文件 expr_lv3play.js） ---- */
  AP.drivers["Level-32004"] = function () {
  // L3 牛排 (-32004) 自动玩驱动 —— 手势版（不是步骤动画直连）
    // 依据（全部来自关卡源码 probe/steak_src_defrag.js 与实机验证）：
    //   · 事件模型：initNodeEvent 给「带 move/click 子节点的方块」注册 touchstart/move/end；
    //     touchstart 记录 startTouchPos；touchmove 把 getDelta() 直接加到节点位置；
    //     touchend → handleTouchNode(target, event)，用 getLocation()-startTouchPos 判断滑动方向，
    //     用 checkIsIntersection(节点包围盒, area 的 PolygonCollider) 判断是否拖到位。
    //   · 因此合成事件必须带 target/getID/getLocation/getDelta，且 __touch 位置要跟着手势走。
    //   · 每步完成信号：C.partInfo[k].completed（游戏自己的 partAnim 在拖放成功后会置位）。
    //   · 兜底：同一步连续多次手势没进展时，调用游戏自身的 partAnim(k)（和之前一致的通关保障）。
    var HL = window.__HLD__;
    var C = null;
    HL.findAll('Level-32004').forEach(function (c) { try { if (HL.clsName(c) === 'Level-32004') C = c; } catch (e) {} });
    if (!C) return 'no C(-32004)';
    if (window.__L3P && window.__L3P.timer) { clearInterval(window.__L3P.timer); window.__L3P.timer = null; }
    var P = window.__L3P = { log: [], t0: Date.now(), done: false, busyUntil: 0, lastK: 0, tries: 0, act: 0, nextAt: 0, falls: 0, cutKey: '' };

    function L() {
      var a = [].slice.call(arguments);
      P.log.push(((Date.now() - P.t0) / 1000).toFixed(1) + 's ' + a.join(' '));
      if (P.log.length > 1500) P.log.splice(0, 700);
    }
    function D(n) { return C.dict[n]; }
    function act(n) { try { return !!(n && n.activeInHierarchy); } catch (e) { return false; } }
    function comp(k) { try { return !!(C.partInfo[k] && C.partInfo[k].completed); } catch (e) { return false; } }
    function stateOk() { try { return C.state === 3; } catch (e) { return false; } }   // 3 = waitTouch
    function tipOf(k) { try { return ((C._touchList || [])[k - 1] || {}).tips || ''; } catch (e) { return ''; } }
    // 切菜进度信号：《牛排》关卡自带的刀数计数器（拖上菜板 caibanFoodId 变化、每点一刀 curCuttingTimes+1）
    function cutKey() {
      try {
        return (C.caibanIsHasFood ? 1 : 0) + '|' + C.caibanFoodId + '|' + C.curCuttingTimes + '|' + C.totalCuttingTimes;
      } catch (e) { return 'cutErr'; }
    }
    function doneCount() { var c = 0; for (var i = 1; i <= 45; i++) if (comp(i)) c++; return c; }
    function snap() {
      try {
        return JSON.stringify({
          sc: C._curSceneIdx, st: C.state, d: doneCount(),
          td: C.tdChanNum, lb: C.lbChanNum, fan: C.fanchaoNum,
          cut: (C.caibanIsHasFood ? C.caibanFoodId : 0)
        });
      } catch (e) { return 'snapErr'; }
    }

    // ---------- 合成触摸（对齐游戏的事件模型）----------
    var TOUCH_ID = 0x4C33;
    var touch = cc.v2(0, 0), lastDelta = cc.v2(0, 0);
    function mkEv(node) {
      return {
        target: node,
        getID: function () { return TOUCH_ID; },
        getLocation: function () { return cc.v2(touch.x, touch.y); },
        getDelta: function () { return cc.v2(lastDelta.x, lastDelta.y); },
        stopPropagation: function () {}, stopPropagationImmediate: function () {}
      };
    }
    function worldOf(n) { return n.convertToWorldSpaceAR(cc.v2(0, 0)); }
    function hasT(n, t) { try { return n.hasEventListener(t); } catch (e) { return false; } }
    function beginTouch(n) { var w = worldOf(n); touch.x = w.x; touch.y = w.y; lastDelta = cc.v2(0, 0); n.emit('touchstart', mkEv(n)); }
    function endTouch(n) { lastDelta = cc.v2(0, 0); n.emit('touchend', mkEv(n)); }
    function areaCentroid(name) {
      var a = D(name);
      if (!a) return null;
      var col = null;
      try { col = a.getComponent(cc.PolygonCollider); } catch (e) { return null; }
      if (!col || !col.points || !col.points.length) return null;
      var pts;
      try { pts = C.getWorldPoints(a, col.points); } catch (e) { return null; }
      var sx = 0, sy = 0;
      for (var i = 0; i < pts.length; i++) { sx += pts[i].x; sy += pts[i].y; }
      return cc.v2(sx / pts.length, sy / pts.length);
    }

    // 拟人拖拽：按下微停 → 起手 → 中段快 → 落点减速，约 0.6~0.8 秒
    var DRAG_HOLD = 80, DRAG_TICK = 38;
    var DRAG_RATIO = [0.06, 0.10, 0.14, 0.18, 0.20, 0.20, 0.18, 0.16, 0.14, 0.12, 0.12, 0.14, 0.18, 0.25, 0.35, 1];
    var JIT = [[0, 0], [0, 30], [0, -30], [30, 0], [-30, 0], [0, 60], [0, -60], [60, 0], [-60, 0], [0, 90], [0, -90], [90, 0], [-90, 0]];
    function dragTo(nodeName, areaName, attempt) {
      var n = D(nodeName), a = D(areaName);
      if (!n) return 'missing ' + nodeName;
      if (!act(n)) return 'inactive ' + nodeName;
      if (!act(a)) return 'area inactive ' + areaName;
      if (!hasT(n, 'touchstart')) return 'no listener ' + nodeName;
      var cent = areaCentroid(areaName);
      if (!cent) return 'no collider ' + areaName;
      var j = JIT[(Math.max(1, attempt || 1) - 1) % JIT.length];
      var world = cc.v2(cent.x + j[0], cent.y + j[1]);
      var want = n.parent.convertToNodeSpaceAR(world);
      beginTouch(n);
      P.busyUntil = Date.now() + 1100;
      var i = 0;
      function tick() {
        var cur = n.getPosition();
        var rem = cc.v2(want.x - cur.x, want.y - cur.y);
        if (i >= DRAG_RATIO.length || rem.mag() < 1.5) {
          endTouch(n);
          P.busyUntil = Date.now() + 300;
          return;
        }
        var r = DRAG_RATIO[i]; i++;
        var d = cc.v2(rem.x * r, rem.y * r);
        lastDelta = d; touch.x += d.x; touch.y += d.y;
        n.emit('touchmove', mkEv(n));
        setTimeout(tick, DRAG_TICK + Math.random() * 8);
      }
      setTimeout(tick, DRAG_HOLD + Math.random() * 50);
      return '拖 ' + nodeName + '→' + areaName + (attempt > 1 ? (' 第' + attempt + '次') : '');
    }

    // 滑动：滑动方向由 getLocation()-startTouchPos 判定（左滑 dx<-30 / 上滑 dy>30）
    function swipe(nodeName, dx, dy) {
      var n = D(nodeName);
      if (!n) return 'missing ' + nodeName;
      if (!act(n)) return 'inactive ' + nodeName;
      if (!hasT(n, 'touchmove')) return 'no touchmove ' + nodeName;
      var w = worldOf(n);
      touch.x = w.x; touch.y = w.y; lastDelta = cc.v2(0, 0);
      n.emit('touchstart', mkEv(n));
      P.busyUntil = Date.now() + 900;
      var steps = 5, k = 0;
      function tick() {
        if (k >= steps) { endTouch(n); P.busyUntil = Date.now() + 300; return; }
        k++;
        var d = cc.v2(dx / steps, dy / steps);
        lastDelta = d; touch.x += d.x; touch.y += d.y;
        n.emit('touchmove', mkEv(n));
        setTimeout(tick, 30 + Math.random() * 10);
      }
      setTimeout(tick, 40 + Math.random() * 25);
      return '滑 ' + nodeName + ' (' + dx + ',' + dy + ')';
    }

    // 点击：按下约 0.1 秒再抬起（游戏里有按压动画）
    function tap(nodeName) {
      var n = D(nodeName);
      if (!n) return 'missing ' + nodeName;
      if (!act(n)) return 'inactive ' + nodeName;
      if (!hasT(n, 'touchend')) return 'no touchend ' + nodeName;
      var w = worldOf(n);
      touch.x = w.x; touch.y = w.y; lastDelta = cc.v2(0, 0);
      n.emit('touchstart', mkEv(n));
      P.busyUntil = Date.now() + 800;
      setTimeout(function () {
        try { endTouch(n); } catch (e) {}
        P.busyUntil = Date.now() + 300;
      }, 70 + Math.random() * 50);
      return '点 ' + nodeName;
    }

    // ---------- 45 步计划（步骤 → 手势；依据 handleTouchNode 的 case 分支）----------
    function dg(name, area) { return { t: 'drag', n: name, a: area }; }
    function sw(name, dx, dy) { return { t: 'swipe', n: name, dx: dx, dy: dy }; }
    function tp(name) { return { t: 'tap', n: name }; }
    var PLAN = {
      1:  [dg('moveBox_tiechan', 'area_tudou')],
      2:  [dg('moveBox_tiechan', 'area_tudou')],
      3:  [dg('moveBox_tiechan', 'area_luobo')],
      4:  [dg('moveBox_tiechan', 'area_luobo')],
      5:  [dg('moveBox_5', 'area_lanzi')],
      6:  [dg('moveBox_6', 'area_lanzi')],
      7:  [dg('moveBox_fanqie1', 'area_lanzi'), dg('moveBox_fanqie2', 'area_lanzi')],
      8:  [dg('moveBox_8', 'area_lanzi')],
      9:  [dg('moveBox_9', 'area_lanzi')],
      10: [dg('moveBox_10', 'area_board')],
      11: [dg('moveBox_11', 'area_board')],
      12: [dg('moveBox_12', 'area_board')],
      13: [sw('slideBox_13', 0, 300)],
      14: [dg('moveBox_14', 'area_board')],
      15: [dg('moveBox_15', 'area_board')],
      16: [dg('moveBox_16', 'area_board')],
      17: [dg('moveBox_17', 'area_board')],
      // 18~23：先把菜拖到菜板，再点刀切（切够刀数游戏自动完成本步）
      18: [{ t: 'cut', n: 'moveBox_18' }],
      19: [{ t: 'cut', n: 'moveBox_19' }],
      20: [{ t: 'cut', n: 'moveBox_20' }],
      21: [{ t: 'cut', n: 'moveBox_21' }],
      22: [{ t: 'cut', n: 'moveBox_22' }],
      23: [{ t: 'cut', n: 'moveBox_23' }],
      24: [tp('clickBox_24')],
      25: [dg('moveBox_25', 'area_guo')],
      26: [dg('moveBox_26', 'area_guo')],
      27: [dg('moveBox_27', 'area_guo')],
      28: [dg('moveBox_28', 'area_guo')],
      29: [dg('moveBox_29', 'area_guo')],
      30: [dg('moveBox_30', 'area_guo')],
      31: [sw('slideBox_31', -300, 0)],
      32: [dg('moveBox_32', 'area_diezi')],
      33: [dg('moveBox_33', 'area_guo')],
      34: [dg('moveBox_34', 'area_guo')],
      35: [dg('moveBox_35', 'area_guo')],
      36: [sw('slideBox_36', -300, 0)],
      37: [dg('moveBox_37', 'area_diezi')],
      38: [dg('moveBox_38', 'area_guo')],
      39: [dg('moveBox_39', 'area_guo')],
      40: [dg('moveBox_40', 'area_guo')],
      41: [dg('moveBox_41', 'area_diezi')],
      42: [tp('clickBox_42')],
      43: [dg('moveBox_43', 'area_panzi')],
      44: [dg('moveBox_44', 'area_panzi')],
      45: [dg('moveBox_45', 'area_panzi')]
    };
    function doAct(step, spec, attempt) {
      if (spec.t === 'drag') return dragTo(spec.n, spec.a, attempt);
      if (spec.t === 'swipe') return swipe(spec.n, spec.dx, spec.dy);
      if (spec.t === 'tap') return tap(spec.n);
      if (spec.t === 'cut') {
        // 菜在板上、刀亮着 → 点刀；否则先把菜拖到菜板
        var onBoard = false;
        try { onBoard = !!(C.caibanIsHasFood) && act(D('knifeBox3')); } catch (e) {}
        if (onBoard) return tap('knifeBox3');
        return dragTo(spec.n, 'area_board', attempt);
      }
      return 'unknown act';
    }
    function fallback(k) {
      P.falls++;
      var r = '';
      try { C.partAnim(k); r = 'partAnim(' + k + ')'; } catch (e) { r = 'partAnim ERR ' + e.message; }
      L('第' + k + '步手势多次未过 → 兜底 ' + r);
      P.tries = 0; P.act = 0;
      P.nextAt = Date.now() + 2200 + Math.random() * 800;
    }

    // ---------- 主循环 ----------
    P.nextAt = Date.now() + 1200 + Math.random() * 1800;   // 进关先看一眼再动手（拟人）
    P.timer = setInterval(function () {
      if (P.done) return;
      var t = Date.now();
      if (t - P.t0 > 900000) { L('GLOBAL TIMEOUT'); P.done = true; clearInterval(P.timer); P.timer = null; return; }
      if (P.busyUntil && t < P.busyUntil) return;
      if (!stateOk()) return;                    // 游戏正在播动画/过场，等它回到「等待操作」
      var k = 0;
      for (var i = 1; i <= 45; i++) { if (!comp(i)) { k = i; break; } }
      if (!k) {
        L('45 步全部完成 ✓ | ' + snap());
        P.done = true; clearInterval(P.timer); P.timer = null;
        return;
      }
      if (P.lastK !== k) {                       // 新步骤：拟人停顿 1~3 秒
        P.lastK = k; P.act = 0; P.tries = 0;
        P.cutKey = '';
        P.nextAt = t + 1000 + Math.random() * 2000;
        L('→ 第' + k + '步 ' + tipOf(k) + ' | ' + snap());
        return;
      }
      if (t < P.nextAt) return;
      var list = PLAN[k];
      if (!list) { fallback(k); return; }
      var isCut = (list[0] && list[0].t === 'cut');
      if (isCut) {                               // 切菜步：刀数有进展就不算失败（游戏吞刀也不误判）
        var ck = cutKey();
        if (ck !== P.cutKey) { P.cutKey = ck; P.tries = 0; }
      }
      P.tries++;
      if (P.tries > (isCut ? 14 : 8)) { fallback(k); return; }
      var spec = list[P.act % list.length];
      P.act++;
      var r = ''; try { r = doAct(k, spec, P.tries) || ''; } catch (e) { r = 'ERR ' + e.message; }
      L('第' + k + '步 ' + r);
      P.nextAt = t + 900 + Math.random() * 900;  // 连续动作之间 0.9~1.8 秒
    }, 250);
    return 'lv3 steak player installed: 45 steps | start=' + snap();
  };

  /* ---- L4  沙威玛（Level-32002，源文件 expr_lv4play4.js） ---- */
  AP.drivers["Level-32002"] = function () {
  var HL = window.__HLD__;
    var C = null;
    HL.findAll('Level-32002').forEach(function (c) { try { if (HL.clsName(c) === 'Level-32002') C = c; } catch (e) {} });
    if (!C) return 'no C';
    if (window.__L4P && window.__L4P.timer) { clearInterval(window.__L4P.timer); window.__L4P.timer = null; }
    var P = window.__L4P = { log: [], t0: Date.now(), i: window.__L4I__ || 0, steps: [], nextAt: 0, done: false };

    function L() {
      var a = [].slice.call(arguments);
      P.log.push(((Date.now() - P.t0) / 1000).toFixed(1) + 's ' + a.join(' '));
      if (P.log.length > 1200) P.log.splice(0, 600);
    }
    function dict(n) { return C.dict[n]; }
    function sc(name, child) { try { var n = C.dict[name]; return child ? n.getChildByName(child) : n; } catch (e) { return null; } }
    function s2n(n) { return sc('scene2', n); }
    function s3n(n) { return sc('scene3', n); }
    function s4n(n) { return sc('scene4', n); }
    function active(n) { try { return !!(n && n.activeInHierarchy); } catch (e) { return false; } }
    function hasL(n, t) { try { return !!(n && n.hasEventListener(t)); } catch (e) { return false; } }
    function par(n) { try { return n && n.parent ? n.parent.name : '?'; } catch (e) { return '?'; } }
    function deepFind(root, name, wantActive) {
      if (!root) return null;
      var kids = root.children || [];
      for (var i = 0; i < kids.length; i++) {
        try { if (kids[i].name === name && (!wantActive || kids[i].activeInHierarchy)) return kids[i]; } catch (e) {}
      }
      for (var j = 0; j < kids.length; j++) {
        var f = deepFind(kids[j], name, wantActive);
        if (f) return f;
      }
      if (wantActive) return deepFind(root, name, false);
      return null;
    }
    function getCakeS2() {
      var p = s2n('pot'); var c = p && p.getChildByName('cake');
      if (c) return c;
      var cp = s2n('cakePlate'); c = cp && cp.getChildByName('cake');
      if (c) return c;
      c = s2n('cake');
      if (c) return c;
      return deepFind(sc('scene2'), 'cake', true);
    }
    function getPotatoS2() {
      var p = s2n('pot'); var c = p && p.getChildByName('potato');
      if (c) return c;
      c = s2n('potato');
      if (c) return c;
      return deepFind(sc('scene2'), 'potato', true);
    }
    function tempN() {
      var p = s2n('pot'); var t = p && p.getChildByName('temp');
      if (t) return t;
      return deepFind(sc('scene2'), 'temp', true);
    }

    // ---------- runtime bind capture (ground truth from the live game) ----------
    window.__BINDS__ = [];
    window.__SCRL__ = [];
    try {
      var proto = C, guard = 0;
      while (proto && !Object.prototype.hasOwnProperty.call(proto, 'bindDragToCorrentPlaceByDistanceEvent') && guard++ < 8) proto = Object.getPrototypeOf(proto);
      if (proto && proto !== Object.prototype && !proto.__CAP4__) {
        proto.__CAP4__ = true;
        var _orD = proto.bindDragToCorrentPlaceByDistanceEvent;
        proto.bindDragToCorrentPlaceByDistanceEvent = function (n, tp, tpos, thr, cb, fb) {
          try { (window.__BINDS__ = window.__BINDS__ || []).push({ t: ((Date.now() - P.t0) / 1000).toFixed(1), node: n && n.name, par: tp && tp.name, x: tpos ? tpos.x : null, y: tpos ? tpos.y : null, thr: thr }); } catch (e) {}
          return _orD.apply(this, arguments);
        };
        var _orS = proto.bindScrollEvent;
        proto.bindScrollEvent = function (n, v, cb) {
          try { (window.__SCRL__ = window.__SCRL__ || []).push({ t: ((Date.now() - P.t0) / 1000).toFixed(1), node: n && n.name, x: v ? v.x : null, y: v ? v.y : null }); } catch (e) {}
          return _orS.apply(this, arguments);
        };
      }
    } catch (e) {}
    function lastAim(name) {
      var a = window.__BINDS__ || [];
      for (var k = a.length - 1; k >= 0; k--) { if (a[k].node === name && a[k].x !== null && a[k].x !== undefined) return [a[k].x, a[k].y]; }
      return null;
    }

    var pending = cc.v2(0, 0);
    function mkEv(node, kind) {
      var p = node.convertToWorldSpaceAR(cc.v2(0, 0));
      return {
        type: kind,
        touch: {
          _point: { sub: function () { return pending; } },
          _startPoint: p, getLocation: function () { return p; }
        },
        getDelta: function () { return pending; },
        stopPropagation: function () {}, stopPropagationImmediate: function () {}
      };
    }
    function drag(node, target, posArr) {
      if (!node || !target) return 'missing node/target';
      if (!hasL(node, 'touchstart')) return 'no touchstart listener';
      pending = cc.v2(0, 0);
      node.emit('touchstart', mkEv(node, 'touchstart'));
      var want = posArr ? cc.v2(posArr[0], posArr[1]) : cc.v2(0, 0);
      P.dragUntil = Date.now() + 1000;              // 拖拽演完之前不开始下一个动作
      setTimeout(function () {                      // 真人按下后有极短的停顿再起手
        dragTick(node, want, 0, function () {
          pending = cc.v2(0, 0);
          node.emit('touchend', mkEv(node, 'touchend'));
          P.dragUntil = Date.now() + 150;           // 落点判定留一点余量
          // 步骤的 wait 从「手指抬起」起算：恢复成和瞬时拖拽时代相同的游戏内节奏
          if (P.pendWait) P.nextAt = Math.max(P.nextAt, Date.now() + P.pendWait);
        });
      }, DRAG_HOLD + Math.random() * 50);
      return 'drag start -> ' + Math.round(want.x) + ',' + Math.round(want.y);
    }
    // 拟人拖拽：原来是 3 帧一瞬间拖完，现在摊到约 0.6 秒（按下微停 → 起手 → 中段快 → 落点减速）
    var DRAG_HOLD = 80, DRAG_TICK = 38;
    var DRAG_RATIO = [0.06, 0.10, 0.14, 0.18, 0.20, 0.20, 0.18, 0.16, 0.14, 0.12, 0.12, 0.14, 0.18, 0.25, 0.35, 1];
    function dragTick(node, want, i, done) {
      var cur = node.getPosition();
      var rem = cc.v2(want.x - cur.x, want.y - cur.y);
      if (i >= DRAG_RATIO.length || rem.mag() < 0.5) { done(); return; }
      var r = DRAG_RATIO[i];
      pending = cc.v2(rem.x * r, rem.y * r);
      node.emit('touchmove', mkEv(node, 'touchmove'));
      setTimeout(function () { dragTick(node, want, i + 1, done); }, DRAG_TICK + Math.random() * 8);
    }
    var OFFS = [[0, 0], [0, 80], [0, -80], [80, 0], [-80, 0], [0, 150], [0, -150], [150, 0], [-150, 0], [0, 250], [0, -250], [250, 0], [-250, 0]];
    function offsetDrag(node, target, attempt, aim) {
      var a = attempt || 1;
      var w;
      if (a === 1) w = aim ? [aim[0], aim[1]] : [0, 0];
      else if (aim && a <= 7) {
        var wb = [[0, 60], [0, -60], [60, 0], [-60, 0], [120, 0], [-120, 0]][(a - 2) % 6];
        w = [aim[0] + wb[0], aim[1] + wb[1]];
      } else { w = OFFS[(a - 1) % OFFS.length]; }
      return drag(node, target, w) + ' w=' + w[0] + ',' + w[1];
    }
    function swipe(node, dx, dy) {
      if (!node) return 'missing node';
      if (!hasL(node, 'touchmove')) return 'no touchmove listener';
      pending = cc.v2(0, 0);
      node.emit('touchstart', mkEv(node, 'touchstart'));
      pending = cc.v2(dx, dy);
      node.emit('touchmove', mkEv(node, 'touchmove'));
      pending = cc.v2(0, 0);
      node.emit('touchend', mkEv(node, 'touchend'));
      return 'ok';
    }
    var DIRS = [[-3000, 0], [3000, 0], [0, 3000], [0, -3000]];
    function swipeAny(node, probeFn) {
      if (!node) return 'missing node';
      if (!hasL(node, 'touchmove')) return 'no touchmove listener';
      var b0; try { b0 = probeFn(); } catch (e) { b0 = -1; }
      for (var i = 0; i < DIRS.length; i++) {
        swipe(node, DIRS[i][0], DIRS[i][1]);
        var b1; try { b1 = probeFn(); } catch (e) { b1 = b0; }
        if (b1 !== b0) return 'fired dir' + i;
      }
      return 'no dir fired';
    }
    function click(node) {
      if (!node) return 'missing';
      if (!hasL(node, 'touchend')) return 'no touchend listener';
      node.emit('touchstart', mkEv(node, 'touchstart'));
      // 真人点击有按下时长（约 0.1 秒），游戏里的按压动画才看得出
      setTimeout(function () {
        try { node.emit('touchend', mkEv(node, 'touchend')); } catch (e) {}
        if (P.pendWait) P.nextAt = Math.max(P.nextAt, Date.now() + P.pendWait);
      }, 70 + Math.random() * 50);
      return 'ok';
    }
    function snap() {
      try {
        var pot = s2n('pot');
        var cake = getCakeS2();
        var potato = getPotatoS2();
        var pt = s2n('potatoTouch'), ct = s2n('chickenTouch'), cp = s2n('chickenProgress'), temp = tempN();
        return JSON.stringify({
          sc: ['scene1', 'scene2', 'scene3', 'scene4', 'sceneFinish'].map(function (k) { return active(dict(k)) ? 1 : 0; }).join(''),
          cake: par(cake) + '/' + (hasL(cake, 'touchstart') ? 'T' : '-') + (hasL(cake, 'touchmove') ? 'M' : '-'),
          pot: pot ? pot.children.map(function (c) { return c.name + (c.active ? '' : '(o)'); }).join(',') : '?',
          potato: par(potato) + (hasL(potato, 'touchstart') ? '/T' : ''),
          pt: (active(pt) ? 1 : 0) + '/' + (hasL(pt, 'touchmove') ? 'M' : '-'),
          ck: (active(ct) ? 1 : 0) + '/' + (hasL(ct, 'touchmove') ? 'M' : '-') + '/p' + (active(cp) ? 1 : 0),
          temp: active(temp) ? 1 : 0,
          k: C._scene2ShovelCount + '/' + C._scene2SkinCount,
          p12: C._scene3Plate1FinishCount + ',' + C._scene3Plate2FinishCount + ',' + C._scene3BrushCount,
          tips: C._tipsOrder, nb: (window.__BINDS__ || []).length
        });
      } catch (e) { return 'snapErr'; }
    }

    function S(o) { P.steps.push(o); }
    function firstNode(sceneName, kind) {
      try {
        var s = sc(sceneName);
        var arr = (s ? s.children : []).filter(function (n) { return n.name === kind && n.active && hasL(n, 'touchstart'); });
        return arr.length ? arr[0] : null;
      } catch (e) { return null; }
    }
    function countKids(sceneName, kind) {
      try { return (sc(sceneName).children || []).filter(function (n) { return n.name === kind; }).length; } catch (e) { return 0; }
    }
    // fixed plate quotas (from game source: plate1 x3 -> plate2 x2 -> plate3 x1)
    var N1 = countKids('scene3', 'plate1') || 3;
    var N2 = countKids('scene3', 'plate2') || 2;
    function firstPlate(scene, kind, target) {
      return function () {
        var ps = (sc(scene) || { children: [] }).children.filter(function (n) {
          return n.name === kind && n.active && hasL(n, 'touchstart');
        });
        ps.sort(function (a, b) {
          var ao = (a.children[0] && a.children[0].name === 'oil') ? 1 : 0;
          var bo = (b.children[0] && b.children[0].name === 'oil') ? 1 : 0;
          return ao - bo;
        });
        return ps.length ? drag(ps[0], target()) : 'none left';
      };
    }
    function counterSwipe(getNode, expr) {
      return function () {
        var n = getNode();
        var r = swipeAny(n, function () { return eval(expr); });
        return r + ' ' + expr + '=' + eval(expr);
      };
    }

    // ---------- scene1 (proven in v3) ----------
    for (var pi = 0; pi < 8; pi++) {
      S({ name: 'plate' + (pi + 1), wait: 700, fn: firstPlate('scene1', 'plate', function () { return dict('bowl'); }) });
    }
    S({ name: 'glove->bowl', wait: 2600, fn: function () { return drag(dict('glove'), dict('bowl')); },
      pre: function () { return C._scene1PlateFinishCount >= 8 && active(dict('glove')) && hasL(dict('glove'), 'touchstart'); } });
    S({ name: 'ovenBottom-swipe', wait: 1200,
      fn: function () { return swipeAny(dict('ovenBottom'), function () { return hasL(dict('clip'), 'touchstart') ? 1 : 0; }); },
      pre: function () { return !active(dict('glove')); } });
    function preClip() { try { return active(dict('doorextra')) && (hasL(dict('clip'), 'touchstart') || C._scene1ClipFinishCount >= 4); } catch (e) { return false; } }
    function preClipmove() { try { return hasL(dict('clipmove'), 'touchstart') || C._scene1ClipFinishCount >= 4; } catch (e) { return false; } }
    S({ name: 'clip->bowl a', wait: 800, fn: function () { return drag(dict('clip'), dict('bowl')); }, pre: preClip });
    S({ name: 'clipmove->oven a', wait: 800, fn: function () { return drag(dict('clipmove'), dict('oven')); }, pre: preClipmove });
    S({ name: 'clip->bowl b', wait: 800, fn: function () { return drag(dict('clip'), dict('bowl')); }, pre: preClip });
    S({ name: 'clipmove->oven b', wait: 800, fn: function () { return drag(dict('clipmove'), dict('oven')); }, pre: preClipmove });
    S({ name: 'clip->bowl c', wait: 800, fn: function () { return drag(dict('clip'), dict('bowl')); }, pre: preClip });
    S({ name: 'clipmove->oven c', wait: 800, fn: function () { return drag(dict('clipmove'), dict('oven')); }, pre: preClipmove });
    S({ name: 'clip->bowl d', wait: 800, fn: function () { return drag(dict('clip'), dict('bowl')); }, pre: preClip });
    S({ name: 'clipmove->oven d', wait: 900, fn: function () { return drag(dict('clipmove'), dict('oven')); }, pre: preClipmove });
    S({ name: 'ovenSwitch-swipe', wait: 1200,
      fn: function () { return swipeAny(dict('ovenSwitch'), function () { return hasL(dict('switch'), 'touchend') ? 1 : 0; }); },
      pre: function () { return hasL(dict('ovenSwitch'), 'touchmove'); } });

    // ---------- scene2 (true chain, aims from live bind capture) ----------
    S({ name: 's1-switch', wait: 1600, fn: function () { return click(dict('switch')); },
      pre: function () { return hasL(dict('switch'), 'touchend'); },
      done: function () { return active(dict('scene2')); }, maxReps: 8 });
    S({ name: 's2-lid-open', wait: 1400, fn: function () { return click(s2n('switch')); },
      pre: function () { return active(dict('scene2')) && hasL(s2n('switch'), 'touchend'); } });
    S({ name: 's2-paint', wait: 2800,
      fn: function (s) { var p = s2n('paintBox'); return offsetDrag(p ? p.getChildByName('paint') : null, s2n('pot'), s.reps, lastAim('paint')); },
      pre: function () { var p = s2n('paintBox'); return p && p.getChildByName('paint') && hasL(p.getChildByName('paint'), 'touchstart'); },
      done: function () {
        var p = s2n('paintBox') && s2n('paintBox').getChildByName('paint');
        if (!p) return false;
        if (hasL(p, 'touchstart')) { window.__paintSaw__ = true; return false; }
        return !!window.__paintSaw__;
      }, maxReps: 6 });
    S({ name: 's2-cake-in', wait: 1100, fn: function (s) { return offsetDrag(getCakeS2(), s2n('pot'), s.reps, lastAim('cake')); },
      pre: function () { var c = getCakeS2(); return active(c) && hasL(c, 'touchstart'); },
      done: function () { return par(getCakeS2()) === 'pot'; }, maxReps: 14 });
    S({ name: 's2-cake-flip', wait: 900,
      fn: function () { return swipeAny(getCakeS2(), function () { return hasL(getCakeS2(), 'touchmove') ? 1 : 0; }); },
      pre: function () { var c = getCakeS2(); return active(c) && hasL(c, 'touchmove'); },
      done: function () { var c = getCakeS2(); return hasL(c, 'touchstart') && hasL(c, 'touchmove'); }, maxReps: 8 });
    S({ name: 's2-cake-out', wait: 1200, fn: function (s) { return offsetDrag(getCakeS2(), s2n('pot'), s.reps, lastAim('cake')); },
      pre: function () { var c = getCakeS2(); return hasL(c, 'touchstart') && par(c) === 'pot'; },
      done: function () { return par(getCakeS2()) === 'cakePlate'; }, maxReps: 14 });
    S({ name: 's2-potato-in', wait: 1100, fn: function (s) { return offsetDrag(getPotatoS2(), s2n('pot'), s.reps, lastAim('potato')); },
      pre: function () { var p = getPotatoS2(); return active(p) && hasL(p, 'touchstart'); },
      done: function () { var p = getPotatoS2(); return par(p) === 'pot' && !hasL(p, 'touchstart'); }, maxReps: 14 });
    S({ name: 's2-shovel', wait: 1300, fn: function (s) { return offsetDrag(s2n('shovel'), s2n('pot'), s.reps, lastAim('shovel')); },
      pre: function () { var sh = s2n('shovel'); return active(sh) && hasL(sh, 'touchstart'); },
      done: function () { var pt = s2n('potatoTouch'); return active(pt) && hasL(pt, 'touchmove'); }, maxReps: 14 });
    S({ name: 's2-potato-cut', wait: 850, fn: function () { return counterSwipe(function () { return s2n('potatoTouch'); }, 'C._scene2ShovelCount')(); },
      pre: function () { var pt = s2n('potatoTouch'); return active(pt) && hasL(pt, 'touchmove'); },
      done: function () { return par(getPotatoS2()) === 'temp' || active(tempN()); }, maxReps: 16 });
    S({ name: 's2-temp', wait: 1300, fn: function (s) { return offsetDrag(tempN(), s2n('pot'), s.reps, lastAim('temp')); },
      pre: function () { var t = tempN(); return active(t) && hasL(t, 'touchstart'); },
      done: function () { return par(getPotatoS2()) === 'potatoPlate'; }, maxReps: 12 });
    S({ name: 's2-glove', wait: 1200, fn: function (s) { return offsetDrag(s2n('glove'), s2n('pot'), s.reps, lastAim('glove')); },
      pre: function () { var g = s2n('glove'); return active(g) && hasL(g, 'touchstart'); },
      done: function () { return !active(s2n('glove')); }, maxReps: 10 });
    S({ name: 's2-chicken-cut', wait: 850, fn: function () { return counterSwipe(function () { return s2n('chickenTouch'); }, 'C._scene2SkinCount')(); },
      pre: function () { var ct = s2n('chickenTouch'); return active(ct) && hasL(ct, 'touchmove'); },
      done: function () { return C._scene2SkinCount >= 12; }, maxReps: 30 });
    S({ name: 's2-lid-close', wait: 1600, fn: function () { return click(s2n('switch')); },
      pre: function () { return hasL(s2n('switch'), 'touchend'); },
      done: function () { return active(dict('scene3')); }, maxReps: 6 });

    // ---------- scene3 ----------
    S({ name: 's3-brush1', wait: 1800, fn: function (s) { return offsetDrag(s3n('brush'), s3n('box'), s.reps, lastAim('brush')); },
      pre: function () { var b = s3n('brush'); return active(b) && hasL(b, 'touchstart'); },
      done: function () { return C._scene3BrushCount >= 1; }, maxReps: 10 });
    S({ name: 's3-brush2', wait: 2600, fn: function (s) { var b2 = s3n('box') && s3n('box').getChildByName('brush'); return offsetDrag(b2 || s3n('brush'), s3n('box'), s.reps, lastAim('brush')); },
      pre: function () { var b2 = (s3n('box') && s3n('box').getChildByName('brush')) || s3n('brush'); return active(b2) && hasL(b2, 'touchstart'); },
      done: function () { return active(s3n('cream')); }, maxReps: 12 });
    S({ name: 's3-plate1', wait: 1000, fn: function (s) { var n = firstNode('scene3', 'plate1'); return n ? offsetDrag(n, s3n('cake'), s.reps) : 'none'; },
      pre: function () { return active(dict('scene3')); },
      done: function () { return C._scene3Plate1FinishCount >= N1; }, maxReps: 20 });
    S({ name: 's3-plate2', wait: 1000, fn: function (s) { var n = firstNode('scene3', 'plate2'); return n ? offsetDrag(n, s3n('cake'), s.reps) : 'none'; },
      pre: function () { return C._scene3Plate1FinishCount >= N1; },
      done: function () { return C._scene3Plate2FinishCount >= N2; }, maxReps: 20 });
    S({ name: 's3-plate3', wait: 1200, fn: function (s) { var n = firstNode('scene3', 'plate3'); return n ? offsetDrag(n, s3n('cake'), s.reps) : 'none'; },
      pre: function () { return C._scene3Plate2FinishCount >= N2; },
      done: function () { return hasL(s3n('cake'), 'touchmove'); }, maxReps: 10 });
    S({ name: 's3-cake-sw1', wait: 900, fn: function () { return swipeAny(s3n('cake'), function () { return hasL(s3n('cake'), 'touchmove') ? 1 : 0; }); },
      pre: function () { return hasL(s3n('cake'), 'touchmove'); },
      done: function () { return !hasL(s3n('cake'), 'touchmove'); }, maxReps: 8 });
    S({ name: 's3-cake-sw2', wait: 900, fn: function () { return swipeAny(s3n('cake'), function () { return hasL(s3n('cake'), 'touchmove') ? 1 : 0; }); },
      pre: function () { return hasL(s3n('cake'), 'touchmove'); },
      done: function () { return active(dict('scene4')); }, maxReps: 10 });

    // ---------- scene4 ----------
    S({ name: 's4-paper', wait: 1500, fn: function () { return drag(s4n('paper'), s4n('plate')); },
      pre: function () { var p = s4n('paper'); return active(p) && hasL(p, 'touchstart'); },
      done: function () { return active(s4n('paperState1')); }, maxReps: 10 });
    S({ name: 's4-sw1', wait: 900, fn: function () { return swipeAny(s4n('paperState1'), function () { return hasL(s4n('paperState1'), 'touchmove') ? 1 : 0; }); },
      pre: function () { return hasL(s4n('paperState1'), 'touchmove'); },
      done: function () { return active(s4n('paperState2')); }, maxReps: 8 });
    S({ name: 's4-sw2', wait: 900, fn: function () { return swipeAny(s4n('paperState2'), function () { return hasL(s4n('paperState2'), 'touchmove') ? 1 : 0; }); },
      pre: function () { return hasL(s4n('paperState2'), 'touchmove'); },
      done: function () { return active(s4n('paperState3')); }, maxReps: 8 });
    S({ name: 's4-sw3', wait: 1200, fn: function () { return swipeAny(s4n('paperState3'), function () { return hasL(s4n('paperState3'), 'touchmove') ? 1 : 0; }); },
      pre: function () { return hasL(s4n('paperState3'), 'touchmove'); },
      done: function () { return active(dict('sceneFinish')); }, maxReps: 10 });
    S({ name: 'all-done', wait: 2500, fn: function () { return 'FINISHED'; } });

    // 拟人：进关卡后先看一眼，1~3 秒后再动手
    P.nextAt = Math.max(P.nextAt || 0, Date.now() + 1000 + Math.random() * 2000);

    P.timer = setInterval(function () {
      if (P.done) return;
      var t = Date.now();
      if (t - P.t0 > 900000) { L('GLOBAL TIMEOUT'); P.done = true; clearInterval(P.timer); P.timer = null; return; }
      if (t < P.nextAt) return;
      if (P.dragUntil && t < P.dragUntil) return;   // 拖拽/点击还在演，先别动
      if (P.i >= P.steps.length) {
        P.done = true; clearInterval(P.timer); P.timer = null;
        L('ALL STEPS END');
        return;
      }
      var s = P.steps[P.i];
      if (s.done) {
        var isDone = false; try { isDone = !!s.done(); } catch (e) { isDone = false; }
        if (isDone) { L('done:', s.name, '|', snap()); P.i++; s.reps = 0; P.nextAt = t + 1000 + Math.random() * 2000; return; }   // 拟人：操作之间停 1~3 秒随机
      }
      var preOk = true;
      if (s.pre) { try { preOk = !!s.pre(); } catch (e) { preOk = false; } }
      if (!preOk) {
        s.waits = (s.waits || 0) + 1;
        if (s.waits % 25 === 1) L('wait:', s.name, '|', snap());
        if (s.waits > (s.maxWait || 60)) { L('GIVEUP-wait:', s.name); P.i++; s.waits = 0; }
        P.nextAt = t + 400;
        return;
      }
      s.waits = 0;
      if (s.done) {
        s.reps = (s.reps || 0) + 1;
        if (s.reps > (s.maxReps || 30)) { L('GIVEUP-reps:', s.name, '|', snap()); P.i++; s.reps = 0; P.nextAt = t + 400; return; }
      }
      var r = ''; try { r = s.fn(s) || ''; } catch (e) { r = 'ERR ' + e.message; }
      L(s.name, '=>', r, '|', snap());
      if (!s.done) P.i++;
      P.pendWait = s.wait || 0;
      P.nextAt = t + s.wait;
    }, 150);
    return 'lv4 player v4 installed: ' + P.steps.length + ' steps | start=' + snap();
  };

  /* ---- L5  玉子烧（Level-31969，源文件 expr_lv5play.js） ---- */
  AP.drivers["Level-31969"] = function () {
  var HL = window.__HLD__;
    var C = null;
    HL.findAll('Level-31969').forEach(function (c) { try { if (HL.clsName(c) === 'Level-31969') C = c; } catch (e) {} });
    if (!C) return 'no C(-31969)';
    if (window.__L5P && window.__L5P.timer) { clearInterval(window.__L5P.timer); window.__L5P.timer = null; }
    var P = window.__L5P = { log: [], t0: Date.now(), done: false, acting: false, step: 0 };

    function L() {
      var a = [].slice.call(arguments);
      P.log.push(((Date.now() - P.t0) / 1000).toFixed(1) + 's ' + a.join(' '));
      if (P.log.length > 800) P.log.splice(0, 400);
    }
    function D(n) { return C.dict[n]; }
    function comp(id) { try { return C.partInfo[id] && C.partInfo[id].completed; } catch (e) { return false; } }
    function st() { return C.state; }

    // touch simulation state
    var touch = cc.v2(0, 0);
    var lastDelta = cc.v2(0, 0);
    function mkEv(node) {
      return {
        target: node,
        getID: function () { return 42; },
        getLocation: function () { return cc.v2(touch.x, touch.y); },
        getDelta: function () { return lastDelta; },
        stopPropagation: function () {}, stopPropagationImmediate: function () {}
      };
    }
    function worldOf(n) { return n.convertToWorldSpaceAR(cc.v2(0, 0)); }
    function localWant(node, targetWorld) {
      return node.parent.convertToNodeSpaceAR(targetWorld);
    }
    function beginTouch(node) {
      var w = worldOf(node);
      touch.x = w.x; touch.y = w.y;
      lastDelta = cc.v2(0, 0);
      node.emit('touchstart', mkEv(node));
    }
    // 拟人拖拽：原来一瞬间拖完，现在摊到约 0.6 秒（按下微停 → 起手 → 中段快 → 落点减速）
    var DRAG_HOLD = 80, DRAG_TICK = 38;
    var DRAG_RATIO = [0.06, 0.10, 0.14, 0.18, 0.20, 0.20, 0.18, 0.16, 0.14, 0.12, 0.12, 0.14, 0.18, 0.25, 0.35, 1];
    function endTouch(node) {
      lastDelta = cc.v2(0, 0);
      node.emit('touchend', mkEv(node));
    }
    function moveTick(node, getWant, i) {
      var want = getWant();                      // 每帧按当前父节点重算（拖拽中可能被重挂）
      var cur = node.getPosition();
      var rem = cc.v2(want.x - cur.x, want.y - cur.y);
      if (i >= DRAG_RATIO.length || rem.mag() < 0.5) { endTouch(node); return; }
      var r = DRAG_RATIO[i];
      lastDelta = cc.v2(rem.x * r, rem.y * r);
      node.emit('touchmove', mkEv(node));
      var w = worldOf(node);
      touch.x = w.x; touch.y = w.y;
      setTimeout(function () { moveTick(node, getWant, i + 1); }, DRAG_TICK + Math.random() * 8);
    }
    function dragTo(node, targetWorld, off) {
      var getWant = function () {
        var w = node.parent.convertToNodeSpaceAR(targetWorld);
        return off ? cc.v2(w.x + off[0], w.y + off[1]) : w;
      };
      beginTouch(node);
      P.dragUntil = Date.now() + 900;            // 拖拽没演完不开始下一个动作
      var w0 = getWant();
      setTimeout(function () { moveTick(node, getWant, 0); }, DRAG_HOLD + Math.random() * 50);
      return 'dragTo(' + Math.round(w0.x) + ',' + Math.round(w0.y) + ')';
    }
    function tap(node, off) {
      var w = worldOf(node);
      var o = off || [0, 0];
      // 起点终点同一个点：移动量 0 < 15px，判定为点击；偏移仅影响落点
      touch.x = w.x + o[0] * 0.4; touch.y = w.y + o[1] * 0.4;
      lastDelta = cc.v2(0, 0);
      node.emit('touchstart', mkEv(node));
      // 真人点击有约 0.1 秒按压时长
      setTimeout(function () { try { lastDelta = cc.v2(0, 0); node.emit('touchend', mkEv(node)); } catch (e) {} }, 70 + Math.random() * 50);
      return 'tap';
    }
    function slide(node, dx) {
      beginTouch(node);
      // 手指滑动：分成 5 帧、约 0.25 秒滑完（原来 2 帧一瞬间，看着不像人）
      lastDelta = cc.v2(0, 0);
      P.dragUntil = Date.now() + 420;
      var n = 5, i = 0;
      var tick = function () {
        if (i >= n) { endTouch(node); return; }
        i++;
        touch.x += dx / n;
        node.emit('touchmove', mkEv(node));
        setTimeout(tick, 45 + Math.random() * 10);
      };
      setTimeout(tick, 70 + Math.random() * 40);
      return 'slide dx=' + dx;
    }

    var JIT = [[0, 0], [0, 40], [0, -40], [40, 0], [-40, 0], [0, 70], [0, -70], [70, 0], [-70, 0], [0, 110], [0, -110]];
    var st8 = { id: 8, type: 'tap', node: 'switchBox', pre: [7] };
    var steps = [
      { id: 1, type: 'drag', node: 'henSk1Box', target: 'nest1', pre: [], reps: 0, max: 8 },
      { id: 2, type: 'drag', node: 'eggBox1', target: 'potNode1', pre: [1], reps: 0, max: 8 },
      { id: 3, type: 'drag', node: 'eggBox2', target: 'potNode1', pre: [1], reps: 0, max: 8 },
      { id: 4, type: 'drag', node: 'milkBox', target: 'potNode1', pre: [2, 3], reps: 0, max: 8 },
      { id: 5, type: 'drag', node: 'saltBox', target: 'potNode1', pre: [4], reps: 0, max: 8 },
      { id: 6, type: 'drag', node: 'sugarBox', target: 'potNode1', pre: [4], reps: 0, max: 8 },
      { id: 7, type: 'drag', node: 'stirrerBox', target: 'potNode1', pre: [5, 6], reps: 0, max: 8 },
      { id: 8, type: 'tap', node: 'switchBox', pre: [7], reps: 0, max: 8 },
      { id: 9, type: 'drag', node: 'brushBox', target: 'potNode2', pre: [8], reps: 0, max: 8 },
      { id: 10, type: 'drag', node: 'bowlBox1', target: 'potNode2', pre: [9], reps: 0, max: 8 },
      { id: 11, type: 'drag', node: 'turner1Box', target: 'potNode2', pre: [10], reps: 0, max: 8 },
      { id: 12, type: 'slideL', node: 'turnerSlideBox1', pre: [11], reps: 0, max: 8 },
      { id: 13, type: 'drag', node: 'bowlBox2', target: 'potNode2', pre: [12], reps: 0, max: 8 },
      { id: 14, type: 'drag', node: 'turner2Box', target: 'potNode2', pre: [13], reps: 0, max: 8 },
      { id: 15, type: 'slideR', node: 'turnerSlideBox2', pre: [14], reps: 0, max: 8 },
      // 注意编号：开关2=20，刀=16，三个点击=17/18/19，锅=21
      { id: 20, type: 'tap', node: 'switchBox2', pre: [15], reps: 0, max: 8 },
      { id: 16, type: 'drag', node: 'knifeBox', target: 'potNode2', pre: [20], reps: 0, max: 8 },
      { id: 17, type: 'tap', node: 'clickBox1', pre: [16], reps: 0, max: 8 },
      { id: 18, type: 'tap', node: 'clickBox2', pre: [17], reps: 0, max: 8 },
      { id: 19, type: 'tap', node: 'clickBox3', pre: [18], reps: 0, max: 8 },
      { id: 21, type: 'serve', node: 'inductionCookerPotBox', pre: [19], reps: 0, max: 8 }
    ];
    P.steps = steps;

    function stepIdx() {
      for (var i = 0; i < steps.length; i++) { if (!comp(steps[i].id)) return i; }
      return -1;
    }
    function acting() { return P.acting; }

    function doStep(s) {
      var node = D(s.node);
      if (!node) { L('#' + s.id, 'NO NODE', s.node); s.reps++; return; }
      if (!node.activeInHierarchy) { L('#' + s.id, 'node inactive, wait', s.node); return; }
      var off = JIT[s.reps % JIT.length];
      P.acting = true;
      var r = '';
      try {
        if (s.type === 'drag') {
          var tgt = D(s.target);
          if (!tgt) { L('#' + s.id, 'NO TARGET', s.target); }
          r = dragTo(node, worldOf(tgt), off);
        } else if (s.type === 'tap') {
          r = tap(node, off);
        } else if (s.type === 'slideL') {
          r = slide(node, -46);
        } else if (s.type === 'slideR') {
          r = slide(node, 46);
        } else if (s.type === 'serve') {
          var scn = D('scrollNode'), b2 = D('bread2'), pot = D('inductionCookerPotBox');
          var sw = worldOf(scn), bw = worldOf(b2), pw = worldOf(pot);
          var want = cc.v2(pw.x + (bw.x - sw.x), pw.y + (bw.y - sw.y));
          var off2 = off;
          want.x += off2[0]; want.y += off2[1];
          r = dragTo(node, want, null);
        }
      } catch (e) { r = 'ERR ' + e.message; }
      s.reps++;
      L('act #' + s.id, s.type, s.node, 'rep' + s.reps, r, 'state=' + st());
      P.acting = false;
      // allow completion window
      s.waitUntil = Date.now() + 900;
    }

    var lastActAt = Date.now(), lastKey = null, gapFor = null, gapAt = 0;   // 拟人节奏：换新操作停 1~3 秒；同一步重复保持原手速
    P.timer = setInterval(function () {
      if (P.done) return;
      var all = steps.every(function (s) { return comp(s.id); });
      if (all) {
        P.done = true;
        L('ALL 21 PARTS COMPLETED', 'state=' + st());
        return;
      }
      if (st() !== 2) { return; }          // waitTouch only
      if (P.acting || Date.now() < (P.dragUntil || 0)) return;
      var now = Date.now();
      var i = stepIdx();
      if (i < 0) return;
      var s = steps[i];
      if (s.id !== lastKey) {              // 新操作：距上次动作停 1~3 秒随机
        if (gapFor !== s.id) { gapFor = s.id; gapAt = lastActAt + 1000 + Math.random() * 2000; }
        if (now < gapAt) return;
      } else if (now - lastActAt < 700) return;
      if (s.reps >= s.max) {
        // stall guard: log & slow down retries
        if (!s._warned || now - s._warned > 4000) { s._warned = now; L('STALL #' + s.id, s.node, 'reps=' + s.reps); }
        return;
      }
      // gate on upstream preconditions via game's own check
      try { if (typeof C.check === 'function' && !C.check(s.id)) { return; } } catch (e) {}
      doStep(s);
      lastActAt = now; lastKey = s.id;
    }, 400);
    L('L5 driver installed; steps=' + steps.length + ' state=' + st());
    return 'L5 driver running';
  };

  /* ---- L6  冬阴功（Level-31957，源文件 expr_lv6play.js） ---- */
  AP.drivers["Level-31957"] = function () {
  var HL = window.__HLD__;
    var C = null;
    HL.findAll('Level-31957').forEach(function (c) { try { if (HL.clsName(c) === 'Level-31957') C = c; } catch (e) {} });
    if (!C) return 'no C(-31957)';
    if (window.__L6P && window.__L6P.timer) { clearInterval(window.__L6P.timer); window.__L6P.timer = null; }
    var P = window.__L6P = { log: [], t0: Date.now(), done: false, acting: false };
    function L() {
      var a = [].slice.call(arguments);
      P.log.push(((Date.now() - P.t0) / 1000).toFixed(1) + 's ' + a.join(' '));
      if (P.log.length > 1000) P.log.splice(0, 500);
    }
    function D(n) { return C.dict[n]; }
    function comp(id) { try { return !!C.partInfo[id].completed; } catch (e) { return false; } }
    function st() { return C.state; }
    var touch = cc.v2(0, 0);
    var lastDelta = cc.v2(0, 0);
    function mkEv(node) {
      return {
        target: node,
        getID: function () { return 77; },
        getLocation: function () { return cc.v2(touch.x, touch.y); },
        getDelta: function () { return lastDelta; },
        stopPropagation: function () {}, stopPropagationImmediate: function () {}
      };
    }
    function worldOf(n) { return n.convertToWorldSpaceAR(cc.v2(0, 0)); }
    function beginTouch(node) {
      var w = worldOf(node);
      touch.x = w.x; touch.y = w.y;
      lastDelta = cc.v2(0, 0);
      node.emit('touchstart', mkEv(node));
    }
    // 拟人拖拽：原来一瞬间拖完，现在摊到约 0.6 秒（按下微停 → 起手 → 中段快 → 落点减速）
    var DRAG_HOLD = 80, DRAG_TICK = 38;
    var DRAG_RATIO = [0.06, 0.10, 0.14, 0.18, 0.20, 0.20, 0.18, 0.16, 0.14, 0.12, 0.12, 0.14, 0.18, 0.25, 0.35, 1];
    function endTouch(node) { lastDelta = cc.v2(0, 0); node.emit('touchend', mkEv(node)); }
    function moveTick(node, getWant, i) {
      var want = getWant();                      // 每帧按当前父节点重算（拖拽中可能被重挂）
      var cur = node.getPosition();
      var rem = cc.v2(want.x - cur.x, want.y - cur.y);
      if (i >= DRAG_RATIO.length || rem.mag() < 0.5) { endTouch(node); return; }
      var r = DRAG_RATIO[i];
      lastDelta = cc.v2(rem.x * r, rem.y * r);
      node.emit('touchmove', mkEv(node));
      var w = worldOf(node);
      touch.x = w.x; touch.y = w.y;
      setTimeout(function () { moveTick(node, getWant, i + 1); }, DRAG_TICK + Math.random() * 8);
    }
    function dragTo(node, targetWorld, off) {
      var getWant = function () {
        var w = node.parent.convertToNodeSpaceAR(targetWorld);
        return off ? cc.v2(w.x + off[0], w.y + off[1]) : w;
      };
      beginTouch(node);
      P.dragUntil = Date.now() + 900;
      var w0 = getWant();
      setTimeout(function () { moveTick(node, getWant, 0); }, DRAG_HOLD + Math.random() * 50);
      return 'dragTo(' + Math.round(w0.x) + ',' + Math.round(w0.y) + ')';
    }
    function tap(node, off) {
      var w = worldOf(node);
      var o = off || [0, 0];
      touch.x = w.x + o[0] * 0.4; touch.y = w.y + o[1] * 0.4;
      lastDelta = cc.v2(0, 0);
      node.emit('touchstart', mkEv(node));
      // 真人点击有约 0.1 秒按压时长
      setTimeout(function () { try { lastDelta = cc.v2(0, 0); node.emit('touchend', mkEv(node)); } catch (e) {} }, 70 + Math.random() * 50);
    }
    var JIT = [[0, 0], [0, 30], [0, -30], [30, 0], [-30, 0], [0, 50], [0, -50], [50, 0], [-50, 0], [0, 80], [0, -80]];
    function veg(id, n) { return { id: id, type: 'veggie', node: 'moveBox_' + n, area: 'area_board', reps: 0, max: 40 }; }
    var steps = [
      { id: 1, type: 'drag', node: 'moveBox_1', area: 'area_board', reps: 0, max: 8 },
      veg(2, 2), veg(3, 3), veg(4, 4), veg(5, 5), veg(6, 6), veg(7, 7), veg(8, 8),
      { id: 9, type: 'tap', node: 'clickBox_9', reps: 0, max: 8 },
      { id: 10, type: 'drag', node: 'moveBox_10', area: 'area_guo', reps: 0, max: 8 },
      { id: 11, type: 'drag', node: 'moveBox_11', area: 'area_guo', reps: 0, max: 8 },
      { id: 12, type: 'drag', node: 'moveBox_12', area: 'area_guo', reps: 0, max: 8 },
      { id: 13, type: 'auto', node: 'clickBox_9', reps: 0, max: 3 },
      { id: 14, type: 'drag', node: 'moveBox_14', area: 'area_guo2', reps: 0, max: 8 },
      { id: 15, type: 'drag', node: 'moveBox_15', area: 'area_guo2', reps: 0, max: 8 },
      { id: 16, type: 'drag', node: 'moveBox_16', area: 'area_guo2', reps: 0, max: 8 },
      { id: 17, type: 'drag', node: 'moveBox_17', area: 'area_guo2', reps: 0, max: 8 },
      { id: 18, type: 'drag', node: 'moveBox_18', area: 'area_guo2', reps: 0, max: 8 },
      { id: 19, type: 'drag', node: 'moveBox_19', area: 'area_guo2', reps: 0, max: 8 },
      { id: 20, type: 'drag', node: 'moveBox_20', area: 'area_guo2', reps: 0, max: 8 },
      { id: 21, type: 'drag', node: 'moveBox_21', area: 'area_guo2', reps: 0, max: 8, needFlag21: true },
      { id: 22, type: 'drag', node: 'moveBox_22', area: 'area_guo2', reps: 0, max: 8 },
      { id: 23, type: 'drag', node: 'moveBox_23', area: 'area_guo2', reps: 0, max: 8 },
      { id: 24, type: 'drag', node: 'moveBox_24', area: 'area_shuicao', reps: 0, max: 8 },
      { id: 25, type: 'drag', node: 'moveBox_25', area: 'area_guo3', reps: 0, max: 8 },
      { id: 26, type: 'tap', node: 'clickBox_26', reps: 0, max: 8 },
      { id: 27, type: 'tap', node: 'clickBox_27', reps: 0, max: 8 },
      { id: 28, type: 'drag', node: 'moveBox_28', area: 'area_shuicao', reps: 0, max: 8 },
      { id: 29, type: 'drag', node: 'moveBox_29', area: 'area_guo3', reps: 0, max: 8 },
      { id: 30, type: 'tap', node: 'clickBox_30', reps: 0, max: 8 },
      { id: 31, type: 'drag', node: 'moveBox_31', area: 'area_guo3', reps: 0, max: 8 },
      { id: 32, type: 'drag', node: 'moveBox_32', area: 'area_32', reps: 0, max: 8 }
    ];
    P.steps = steps;
    function stepIdx() {
      for (var i = 0; i < steps.length; i++) if (!comp(steps[i].id)) return i;
      return -1;
    }
    function act(s) {
      var node = D(s.node);
      P.acting = true;
      var r = '';
      try {
        if (s.type === 'veggie') {
          var kb = D('knifeBox3');
          if (C.caibanFoodId === s.id && C.caibanIsHasFood && kb && kb.activeInHierarchy) {
            tap(kb, null);
            r = 'cut tap ' + C.curCuttingTimes + '/' + C.totalCuttingTimes;
          } else {
            var ab = D(s.area);
            if (!node || !node.activeInHierarchy) { r = 'node inactive'; }
            else if (!ab || !ab.activeInHierarchy) { r = 'area inactive'; }
            else { dragTo(node, worldOf(ab), JIT[s.reps % JIT.length]); r = 'drag->' + s.area; }
          }
        } else if (s.type === 'drag') {
          var ar = D(s.area);
          if (!node || !node.activeInHierarchy) { r = 'node inactive'; }
          else if (!ar || !ar.activeInHierarchy) { r = 'area inactive'; }
          else { dragTo(node, worldOf(ar), JIT[s.reps % JIT.length]); r = 'drag->' + s.area; }
        } else if (s.type === 'tap') {
          if (!node || !node.activeInHierarchy) { r = 'node inactive'; }
          else { tap(node, JIT[s.reps % JIT.length]); r = 'tap'; }
        } else if (s.type === 'auto') {
          if (s.reps === 0 && node && node.activeInHierarchy) { tap(node, null); r = 'tap switch'; }
          else r = 'wait auto-cook';
        }
      } catch (e) { r = 'ERR ' + e.message; }
      s.reps++;
      L('act #' + s.id, s.type, s.node, 'rep' + s.reps, r, 'state=' + st());
      P.acting = false;
    }
    var lastAt = Date.now(), lastKey = null, gapFor = null, gapAt = 0;   // 拟人节奏：换新操作停 1~3 秒；同一步重复保持原手速
    P.timer = setInterval(function () {
      if (P.done) return;
      var all = true;
      for (var i = 0; i < steps.length; i++) if (!comp(steps[i].id)) { all = false; break; }
      if (all) { P.done = true; L('ALL 32 PARTS COMPLETED'); return; }
      if (st() !== 3) return;
      if (P.acting || Date.now() < (P.dragUntil || 0)) return;
      var now = Date.now();
      var i2 = stepIdx();
      if (i2 < 0) return;
      var s = steps[i2];
      if (s.id !== lastKey) {              // 新操作：距上次动作停 1~3 秒随机
        if (gapFor !== s.id) { gapFor = s.id; gapAt = lastAt + 1000 + Math.random() * 2000; }
        if (now < gapAt) return;
      } else if (now - lastAt < 650) return;
      if (s.type !== 'auto' && s.reps >= s.max) {
        if (!s._warned || now - s._warned > 5000) { s._warned = now; L('STALL #' + s.id, s.node, 'reps=' + s.reps); }
        return;
      }
      try { if (!C.isCanUse(s.id)) return; } catch (e) {}
      if (s.needFlag21 && !C.flagStep21) return;
      act(s);
      lastAt = now; lastKey = s.id;
    }, 350);
    L('L6 driver installed; steps=' + steps.length + ' state=' + st());
    return 'L6 driver running';
  };

  /* ---- L7  蛋炒饭（Level-31968，源文件 expr_lv7play.js） ---- */
  AP.drivers["Level-31968"] = function () {
  var HL = window.__HLD__;
    var C = null;
    HL.findAll('Level-31968').forEach(function (c) { try { if (HL.clsName(c) === 'Level-31968') C = c; } catch (e) {} });
    if (!C) return 'no C(-31968)';
    if (window.__L7P && window.__L7P.timer) { clearInterval(window.__L7P.timer); window.__L7P.timer = null; }
    var P = window.__L7P = { log: [], t0: Date.now(), done: false, acting: false, busyUntil: 0 };
    function L() { var a = [].slice.call(arguments); P.log.push(((Date.now() - P.t0) / 1000).toFixed(1) + 's ' + a.join(' ')); if (P.log.length > 1500) P.log.splice(0, 800); }
    function D(n) { return C.dict[n]; }
    function comp(id) { try { return !!C.partInfo[id].completed; } catch (e) { return false; } }
    function st() { return C.state; }
    function act(n) { try { return !!n && n.activeInHierarchy; } catch (e) { return false; } }

    var touch = cc.v2(0, 0), lastDelta = cc.v2(0, 0);
    function mkEv(node) {
      return {
        target: node,
        getID: function () { return 77; },
        getLocation: function () { return cc.v2(touch.x, touch.y); },
        getDelta: function () { return lastDelta; },
        stopPropagation: function () {}, stopPropagationImmediate: function () {}
      };
    }
    function worldOf(n) { return n.convertToWorldSpaceAR(cc.v2(0, 0)); }
    function beginTouch(node) { var w = worldOf(node); touch.x = w.x; touch.y = w.y; lastDelta = cc.v2(0, 0); node.emit('touchstart', mkEv(node)); }
    // 拟人拖拽：原来一瞬间拖完，现在摊到约 0.6 秒（按下微停 → 起手 → 中段快 → 落点减速）
    var DRAG_HOLD = 80, DRAG_TICK = 38;
    var DRAG_RATIO = [0.06, 0.10, 0.14, 0.18, 0.20, 0.20, 0.18, 0.16, 0.14, 0.12, 0.12, 0.14, 0.18, 0.25, 0.35, 1];
    function endTouch(node) { lastDelta = cc.v2(0, 0); node.emit('touchend', mkEv(node)); }
    function moveTick(node, getWant, i) {
      var want = getWant();                      // 每帧按当前父节点重算（拖拽中可能被重挂）
      var cur = node.getPosition();
      var rem = cc.v2(want.x - cur.x, want.y - cur.y);
      if (i >= DRAG_RATIO.length || rem.mag() < 0.5) { endTouch(node); return; }
      var r = DRAG_RATIO[i];
      lastDelta = cc.v2(rem.x * r, rem.y * r);
      node.emit('touchmove', mkEv(node));
      var w = worldOf(node);
      touch.x = w.x; touch.y = w.y;
      setTimeout(function () { moveTick(node, getWant, i + 1); }, DRAG_TICK + Math.random() * 8);
    }
    function dragTo(node, targetWorld, off) {
      var getWant = function () {
        var w = node.parent.convertToNodeSpaceAR(targetWorld);
        return off ? cc.v2(w.x + off[0], w.y + off[1]) : w;
      };
      beginTouch(node);
      P.dragUntil = Date.now() + 900;
      var w0 = getWant();
      setTimeout(function () { moveTick(node, getWant, 0); }, DRAG_HOLD + Math.random() * 50);
      return 'dragTo(' + Math.round(w0.x) + ',' + Math.round(w0.y) + ')';
    }
    function tap(node, off) {
      var w = worldOf(node);
      var o = off || [0, 0];
      touch.x = w.x + o[0] * 0.4; touch.y = w.y + o[1] * 0.4;
      lastDelta = cc.v2(0, 0);
      node.emit('touchstart', mkEv(node));
      // 真人点击有约 0.1 秒按压时长
      setTimeout(function () { try { lastDelta = cc.v2(0, 0); node.emit('touchend', mkEv(node)); } catch (e) {} }, 70 + Math.random() * 50);
    }
    function swipeUp(node, dy) {
      var d = dy || 90;
      var w = worldOf(node);
      touch.x = w.x; touch.y = w.y;
      lastDelta = cc.v2(0, 0);
      node.emit('touchstart', mkEv(node));
      touch.y = w.y + d; lastDelta = cc.v2(0, d);
      node.emit('touchmove', mkEv(node));
      touch.y = w.y + d + 6;
      node.emit('touchend', mkEv(node));
    }
    function holdNode(node, ms) {
      beginTouch(node);
      P.busyUntil = Date.now() + ms + 250;
      var nd = node;
      setTimeout(function () { try { endTouch(nd); } catch (e) {} }, ms);
    }
    function firstActive(list) {
      for (var i = 0; i < list.length; i++) { var n = D(list[i]); if (act(n)) return n; }
      return null;
    }

    // 切菜流水线：放菜上砧板 -> 拖刀子上砧板 -> 点刀切 -> 拖切好的到小盆（第12步是胡萝卜削皮后直接接管）
    function vegAct(id) {
      var cut = D('cutVagetableBox_' + id);
      var fresh = D('moveBox_' + id);
      var kb = D('knifeBox3');
      var ks = D('knifeSk2');
      if (act(cut)) { dragTo(cut, worldOf(D('area_pen'))); return 'cutFood' + id + '->pen'; }
      if (C.caibanIsHasFood && Number(C.caibanFoodId) === id) {
        if (ks && ks.active !== true) {
          var kd = D('moveBox_dao');
          if (act(kd)) { dragTo(kd, worldOf(D('area_board'))); return 'knife->board'; }
          return 'knife not found';
        }
        if (act(kb)) { tap(kb); return 'knife tap ' + C.curCuttingTimes + '/' + C.totalCuttingTimes; }
        return 'wait knife';
      }
      if (id !== 12 && act(fresh) && !C.caibanIsHasFood) { dragTo(fresh, worldOf(D('area_board'))); return 'food' + id + '->board'; }
      return 'wait';
    }

    var steps = {
      1: function () { tap(D('clickBox_1')); return 'corn tap tempNum=' + C.tempNum; },
      2: function () { dragTo(D('moveBox_2'), worldOf(D('area_2'))); return 'corn kernels->hen'; },
      3: function () {
        var e = firstActive(['moveBox_jidan1', 'moveBox_jidan2', 'moveBox_jidan3']);
        if (!e) return 'no egg left';
        dragTo(e, worldOf(D('area_3'))); return 'egg->basket ' + e.name;
      },
      4: function () { return 'auto (3rd egg marks it)'; },
      5: function () {
        var e = firstActive(['moveBox_jidan4', 'moveBox_jidan5', 'moveBox_jidan6']);
        if (!e) return 'no egg left';
        dragTo(e, worldOf(D('area_5'))); return 'egg->bowl ' + e.name;
      },
      6: function () { dragTo(D('moveBox_6'), worldOf(D('area_5'))); return 'salt->bowl'; },
      7: function () { dragTo(D('moveBox_7'), worldOf(D('area_5'))); return 'whisk->bowl'; },
      8: function () { return 'auto (whisk anim stirs)'; },
      9: function () { return vegAct(9); },
      10: function () { return vegAct(10); },
      11: function () {
        var lb = D('show_luobo');
        if (act(lb)) { dragTo(D('moveBox_xiaopidao'), worldOf(D('area_board'))); return 'peeler->carrot'; }
        if (act(D('moveBox_11')) && !C.caibanIsHasFood) { dragTo(D('moveBox_11'), worldOf(D('area_board'))); return 'carrot->board'; }
        return 'wait carrot';
      },
      12: function () { return vegAct(12); },
      13: function () { swipeUp(D('slideBox_13'), 90); return 'scallion swipe up'; },
      14: function () { return vegAct(14); },
      15: function () { tap(D('clickBox_15')); return 'stove switch on'; },
      16: function () { dragTo(D('moveBox_16'), worldOf(D('area_guo'))); return 'oil->pot'; },
      17: function () { dragTo(D('moveBox_17'), worldOf(D('area_guo'))); return 'eggLiquid->pot'; },
      18: function () { dragTo(D('moveBox_18'), worldOf(D('area_guo'))); return 'spatula18'; },
      19: function () { dragTo(D('moveBox_19'), worldOf(D('area_guo'))); return 'rice->pot'; },
      20: function () { dragTo(D('moveBox_20'), worldOf(D('area_guo'))); return 'spatula20'; },
      21: function () {
        var f = firstActive(['foodMoveBox_211', 'foodMoveBox_212', 'foodMoveBox_213']);
        if (!f) return 'no diced food left';
        dragTo(f, worldOf(D('area_guo'))); return 'dices->pot ' + f.name;
      },
      22: function () { dragTo(D('moveBox_22'), worldOf(D('area_guo'))); return 'spatula22'; },
      23: function () { dragTo(D('moveBox_23'), worldOf(D('area_guo'))); return 'salt->pot'; },
      24: function () { dragTo(D('moveBox_24'), worldOf(D('area_guo'))); return 'spatula24'; },
      25: function () { dragTo(D('moveBox_25'), worldOf(D('area_guo'))); return 'scallion->pot'; },
      26: function () {
        if (act(D('clickBox_26'))) { tap(D('clickBox_26')); return 'stove off click'; }
        if (act(D('longBox_26'))) { holdNode(D('longBox_26'), 1600); return 'stove knob hold'; }
        return 'wait 26';
      }
    };

    function stepIdx() { for (var i = 1; i <= 26; i++) if (!comp(i)) return i; return -1; }
    P.progress = function () { var a = []; for (var i = 1; i <= 26; i++) if (comp(i)) a.push(i); return a; };

    var lastAt = Date.now(), lastReport = 0, lastKey = null, gapFor = null, gapAt = 0;   // 拟人节奏：换新操作停 1~3 秒；同一步重复保持原手速
    P.timer = setInterval(function () {
      if (P.done) return;
      if (Date.now() < P.busyUntil) return;
      if (P.acting || Date.now() < (P.dragUntil || 0)) return;
      var all = true;
      for (var i = 1; i <= 26; i++) { if (!comp(i)) { all = false; break; } }
      if (all) { P.done = true; L('ALL 26 PARTS COMPLETED'); return; }
      var now = Date.now();
      if (now - lastReport > 10000) { lastReport = now; L('progress: ' + P.progress().join(',')); }
      if (st() !== 3) return;
      if (C.playingAnim) return;
      var i2 = stepIdx();
      if (i2 < 0) return;
      if (i2 !== lastKey) {                // 新操作：距上次动作停 1~3 秒随机
        if (gapFor !== i2) { gapFor = i2; gapAt = lastAt + 1000 + Math.random() * 2000; }
        if (now < gapAt) return;
      } else if (now - lastAt < 680) return;
      P.acting = true;
      var r = '';
      try { r = steps[i2]() || ''; } catch (e) { r = 'ERR ' + e.message; }
      P.acting = false;
      L('act #' + i2 + ' ' + r + ' state=' + st());
      lastAt = now; lastKey = i2;
    }, 250);
    L('L7 driver installed.. already=' + P.progress().join(','));
    return 'L7 driver running, already done: ' + P.progress().join(',');
  };

  /* ---- L8  三明治（Level-32005，源文件 expr_lv8play.js） ---- */
  AP.drivers["Level-32005"] = function () {
  var HL = window.__HLD__;
    var C = null;
    HL.findAll('Level-32005').forEach(function (c) { try { if (HL.clsName(c) === 'Level-32005') C = c; } catch (e) {} });
    if (!C) return 'no C(-32005)';
    if (window.__L8P && window.__L8P.timer) { clearInterval(window.__L8P.timer); window.__L8P.timer = null; }
    var P = window.__L8P = { log: [], t0: Date.now(), done: false, acting: false, busyUntil: 0 };
    function L() { var a = [].slice.call(arguments); P.log.push(((Date.now() - P.t0) / 1000).toFixed(1) + 's ' + a.join(' ')); if (P.log.length > 1500) P.log.splice(0, 800); }
    function D(n) { return C.dict[n]; }
    function comp(id) { try { return !!C.partInfo[id].completed; } catch (e) { return false; } }
    function st() { return C.state; }
    function act(n) { try { return !!n && n.activeInHierarchy; } catch (e) { return false; } }

    var touch = cc.v2(0, 0), lastDelta = cc.v2(0, 0);
    function mkEv(node) {
      return {
        target: node,
        getID: function () { return 77; },
        getLocation: function () { return cc.v2(touch.x, touch.y); },
        getDelta: function () { return lastDelta; },
        stopPropagation: function () {}, stopPropagationImmediate: function () {}
      };
    }
    function worldOf(n) { return n.convertToWorldSpaceAR(cc.v2(0, 0)); }
    function beginTouch(node) { var w = worldOf(node); touch.x = w.x; touch.y = w.y; lastDelta = cc.v2(0, 0); node.emit('touchstart', mkEv(node)); }
    // 拟人拖拽：原来一瞬间拖完，现在摊到约 0.6 秒（按下微停 → 起手 → 中段快 → 落点减速）
    // 每帧都按节点"当前父节点"重新换算目标，适配拖拽中重挂 tempRoot 的坐标空间变化
    var DRAG_HOLD = 80, DRAG_TICK = 38;
    var DRAG_RATIO = [0.06, 0.10, 0.14, 0.18, 0.20, 0.20, 0.18, 0.16, 0.14, 0.12, 0.12, 0.14, 0.18, 0.25, 0.35, 1];
    function endTouch(node) { lastDelta = cc.v2(0, 0); node.emit('touchend', mkEv(node)); }
    function moveTick(node, targetWorld, i) {
      var want = node.parent.convertToNodeSpaceAR(targetWorld);
      var cur = node.getPosition();
      var rem = cc.v2(want.x - cur.x, want.y - cur.y);
      if (i >= DRAG_RATIO.length || rem.mag() < 0.5) { endTouch(node); return; }
      var r = DRAG_RATIO[i];
      lastDelta = cc.v2(rem.x * r, rem.y * r);
      node.emit('touchmove', mkEv(node));
      var w = worldOf(node);
      touch.x = w.x; touch.y = w.y;
      setTimeout(function () { moveTick(node, targetWorld, i + 1); }, DRAG_TICK + Math.random() * 8);
    }
    function dragTo(node, targetWorld, off) {
      var tw = targetWorld;
      if (off) tw = cc.v2(targetWorld.x + off[0], targetWorld.y + off[1]);
      beginTouch(node);
      P.dragUntil = Date.now() + 900;
      setTimeout(function () { moveTick(node, tw, 0); }, DRAG_HOLD + Math.random() * 50);
    }
    function tap(node, off) {
      var w = worldOf(node);
      var o = off || [0, 0];
      touch.x = w.x + o[0] * 0.4; touch.y = w.y + o[1] * 0.4;
      lastDelta = cc.v2(0, 0);
      node.emit('touchstart', mkEv(node));
      // 真人点击有约 0.1 秒按压时长
      setTimeout(function () { try { lastDelta = cc.v2(0, 0); node.emit('touchend', mkEv(node)); } catch (e) {} }, 70 + Math.random() * 50);
    }

    // 33 步计划（来自关卡源码 handleTouchNode 全量解析）
    var plan = {
      1: { t: 'tap', n: 'switchBox1' },
      2: { d: 'brushBox1', a: 'potNode' },
      3: { d: 'cj1_eggBox1', a: 'potNode' },
      4: { d: 'turnerBox1', a: 'potNode' },
      5: { d: 'potEggBox1', a: 'cj1_dish5' },
      6: { d: 'cj1_eggBox2', a: 'potNode' },
      7: { d: 'turnerBox2', a: 'potNode' },
      8: { d: 'potEggBox2', a: 'cj1_dish5' },
      9: { d: 'brushBox2', a: 'potNode' },
      10: { d: 'knifeBox1', a: 'cj1_dish2' },
      11: { d: 'knifeBox2', a: 'cj1_dish2' },
      12: { d: 'cj1_sausageBox', a: 'potNode' },
      13: { d: 'turnerBox3', a: 'potNode' },
      14: { d: 'potSausageBox', a: 'cj1_dish2' },
      15: { d: 'brushBox3', a: 'potNode' },
      16: { d: 'cj1_breadBox', a: 'potNode' },
      17: { t: 'tap', n: 'breadClickBox1' },
      18: { t: 'tap', n: 'pushBox1' },
      19: { d: 'turnerBox4', a: 'potNode' },
      20: { t: 'tap', n: 'breadClickBox2' },
      21: { t: 'tap', n: 'pushBox2' },
      22: { d: 'potBreadBox', a: 'cj1_dish4' },
      23: { t: 'tap', n: 'switchBox2' },
      24: { d: 'redBrushBox', a: 'cj2_breadBox1' },
      25: { d: 'redBrushBox', a: 'cj2_breadBox2' },
      26: { d: 'bowlEggBox1', a: 'cj2_breadBox2' },
      27: { d: 'bowlSausageBox', a: 'cj2_breadBox2' },
      28: { dL: ['lettuceBox1', 'lettuceBox2'], a: 'cj2_breadBox2' },
      29: { d: 'bowlEggBox2', a: 'cj2_breadBox2' },
      30: { dL: ['tomatoBox1', 'tomatoBox2'], a: 'cj2_breadBox2' },
      31: { d: 'cj2_breadBox1', a: 'cj2_breadBox2' },
      32: { d: 'plasticWrapBox', a: 'sandwich1' },
      33: { d: 'knifeBox3', a: 'sandwich2' }
    };
    var JIT = [[0, 0], [0, 40], [0, -40], [40, 0], [-40, 0], [0, 70], [0, -70], [70, 0], [-70, 0], [0, 100], [0, -100], [100, 0], [-100, 0]];
    var tries = {};

    function firstActive(list) {
      for (var i = 0; i < list.length; i++) { var n = D(list[i]); if (act(n)) return n; }
      return null;
    }
    function doPlan(id) {
      var s = plan[id];
      if (!s) return 'no plan for ' + id;
      var n = s.dL ? firstActive(s.dL) : D(s.d);
      if (s.t === 'tap') {
        if (!act(D(s.n))) return 'node inactive ' + s.n;
        tap(D(s.n));
        return 'tap ' + s.n;
      }
      if (!n) return 'no node ' + (s.d || s.dL.join('/'));
      if (!act(n)) return 'inactive ' + n.name;
      var tgt = D(s.a);
      if (!tgt) return 'no target ' + s.a;
      var off = JIT[(tries[id] || 0) % JIT.length];
      dragTo(n, worldOf(tgt), off);
      var ok = false;
      try { ok = n.getBoundingBoxToWorld().intersects(tgt.getBoundingBoxToWorld()); } catch (e) {}
      var nw = worldOf(n);
      return n.name + '->' + s.a + ' off(' + off.join(',') + ') hit=' + ok + ' at=' + Math.round(nw.x) + ',' + Math.round(nw.y);
    }

    function stepIdx() {
      for (var i = 1; i <= 33; i++) {
        if (comp(i)) continue;
        try { if (!C.check(i)) continue; } catch (e) { continue; }
        return i;
      }
      return -1;
    }
    P.progress = function () { var a = []; for (var i = 1; i <= 33; i++) if (comp(i)) a.push(i); return a; };

    var lastAt = Date.now(), lastReport = 0, pendingId = -1, pendingAt = 0, lastKey = null, gapFor = null, gapAt = 0;   // 拟人节奏：换新操作停 1~3 秒
    P.timer = setInterval(function () {
      if (P.done) return;
      if (Date.now() < P.busyUntil) return;
      if (P.acting || Date.now() < (P.dragUntil || 0)) return;
      var all = true;
      for (var i = 1; i <= 33; i++) { if (!comp(i)) { all = false; break; } }
      if (all) { P.done = true; L('ALL 33 PARTS COMPLETED'); return; }
      var now = Date.now();
      if (now - lastReport > 15000) { lastReport = now; L('progress: ' + P.progress().join(',')); }
      // 上一步没生效 → 计入重试
      if (pendingId > 0 && now - pendingAt > 2600 && !comp(pendingId)) {
        tries[pendingId] = (tries[pendingId] || 0) + 1;
        if (tries[pendingId] === 5) L('STALL #' + pendingId + ' attempts=' + tries[pendingId]);
        pendingAt = now;
      }
      if (st() !== 2) return;
      var id = stepIdx();
      if (id < 0) return;
      if (id !== lastKey) {                // 新操作：距上次动作停 1~3 秒随机
        if (gapFor !== id) { gapFor = id; gapAt = lastAt + 1000 + Math.random() * 2000; }
        if (now < gapAt) return;
      } else if (now - lastAt < 900) return;
      P.acting = true;
      var r = '';
      try { r = doPlan(id) || ''; } catch (e) { r = 'ERR ' + e.message; }
      P.acting = false;
      L('act #' + id + ' ' + r + ' state=' + st());
      pendingId = id; pendingAt = now;
      lastAt = now; lastKey = id;
      P.busyUntil = now + 400;
    }, 250);
    L('L8 driver installed.. already=' + P.progress().join(','));
    return 'L8 driver running, already done: [' + P.progress().join(',') + '] state=' + st();
  };

  /* ---- L9  烤鸡（Level-31935，源文件 expr_lv9play.js） ---- */
  AP.drivers["Level-31935"] = function () {
  var HL = window.__HLD__;
    var C = null;
    HL.findAll('Level-31935').forEach(function (c) { try { if (HL.clsName(c) === 'Level-31935') C = c; } catch (e) {} });
    if (!C) return 'no C(-31935)';
    if (window.__L9P && window.__L9P.timer) { clearInterval(window.__L9P.timer); window.__L9P.timer = null; }
    var P = window.__L9P = { log: [], t0: Date.now(), done: false, acting: false, busyUntil: 0 };
    function L() { var a = [].slice.call(arguments); P.log.push(((Date.now() - P.t0) / 1000).toFixed(1) + 's ' + a.join(' ')); if (P.log.length > 2000) P.log.splice(0, 1000); }
    function D(n) { return C.dict[n]; }
    function comp(id) { try { return !!C.partInfo[id].completed; } catch (e) { return false; } }
    function st() { return C.state; }
    function act(n) { try { return !!n && n.activeInHierarchy; } catch (e) { return false; } }

    var touch = cc.v2(0, 0), lastDelta = cc.v2(0, 0);
    function mkEv(node) {
      return {
        target: node,
        getID: function () { return 77; },
        getLocation: function () { return cc.v2(touch.x, touch.y); },
        getDelta: function () { return lastDelta; },
        stopPropagation: function () {}, stopPropagationImmediate: function () {}
      };
    }
    function worldOf(n) { return n.convertToWorldSpaceAR(cc.v2(0, 0)); }
    function beginTouch(node) { var w = worldOf(node); touch.x = w.x; touch.y = w.y; lastDelta = cc.v2(0, 0); node.emit('touchstart', mkEv(node)); }
    // 拟人拖拽：原来一瞬间拖完，现在摊到约 0.6 秒（按下微停 → 起手 → 中段快 → 落点减速）
    // 每帧都按“当前父节点”重算目标（适配拖拽中重挂 tempRoot）
    var DRAG_HOLD = 80, DRAG_TICK = 38;
    var DRAG_RATIO = [0.06, 0.10, 0.14, 0.18, 0.20, 0.20, 0.18, 0.16, 0.14, 0.12, 0.12, 0.14, 0.18, 0.25, 0.35, 1];
    function endTouch(node) { lastDelta = cc.v2(0, 0); node.emit('touchend', mkEv(node)); }
    function moveTick(node, targetWorld, i) {
      var want = node.parent.convertToNodeSpaceAR(targetWorld);
      var cur = node.getPosition();
      var rem = cc.v2(want.x - cur.x, want.y - cur.y);
      if (i >= DRAG_RATIO.length || rem.mag() < 0.5) { endTouch(node); return; }
      var r = DRAG_RATIO[i];
      lastDelta = cc.v2(rem.x * r, rem.y * r);
      node.emit('touchmove', mkEv(node));
      var w = worldOf(node);
      touch.x = w.x; touch.y = w.y;
      setTimeout(function () { moveTick(node, targetWorld, i + 1); }, DRAG_TICK + Math.random() * 8);
    }
    function dragTo(node, targetWorld, off) {
      var tw = targetWorld;
      if (off) tw = cc.v2(targetWorld.x + off[0], targetWorld.y + off[1]);
      beginTouch(node);
      P.dragUntil = Date.now() + 900;
      setTimeout(function () { moveTick(node, tw, 0); }, DRAG_HOLD + Math.random() * 50);
    }
    function tap(node, off) {
      var w = worldOf(node);
      var o = off || [0, 0];
      touch.x = w.x + o[0] * 0.4; touch.y = w.y + o[1] * 0.4;
      lastDelta = cc.v2(0, 0);
      node.emit('touchstart', mkEv(node));
      // 真人点击有约 0.1 秒按压时长
      setTimeout(function () { try { lastDelta = cc.v2(0, 0); node.emit('touchend', mkEv(node)); } catch (e) {} }, 70 + Math.random() * 50);
    }
    // 滑动：位移量决定方向（dx>30 右 / dx<-30 左 / dy>30 上 / dy<-30 下）
    function swipeLive(node, dx, dy) {
      var w = worldOf(node);
      touch.x = w.x; touch.y = w.y;
      lastDelta = cc.v2(0, 0);
      node.emit('touchstart', mkEv(node));
      // 快滑（甩一下）：4 帧、约 0.16 秒——真人甩手本来就快，但不是一个 0 秒瞬间
      var n = 4, k = 0;
      var tick = function () {
        if (k >= n) { lastDelta = cc.v2(0, 0); node.emit('touchend', mkEv(node)); return; }
        k++;
        touch.x = w.x + dx * k / n; touch.y = w.y + dy * k / n;
        lastDelta = cc.v2(dx / n, dy / n);
        node.emit('touchmove', mkEv(node));
        setTimeout(tick, 30 + Math.random() * 10);
      };
      setTimeout(tick, 40 + Math.random() * 25);
    }

    // 计划表（来自 handleTouchNode 全量解析）
    var plan = {
      1: { t: 'tap', n: 'webBox' },
      2: { t: 'tap', n: 'henSk1Box' },
      3: { dL: ['coverBox1', 'coverBox2'], a: 'cover' },
      4: { t: 'tap', n: 'faucetBox1' },
      5: { d: 'boardChikenBox1', a: 'platformNode' },
      6: { d: 'waterChikenBox1', a: 'boradNode' },
      7: { t: 'tap', n: 'centerCoverBox' },
      8: { d: 'tissueBox', a: 'boradNode' },
      9: { d: 'paperBallBox', a: 'trashBinNode' },
      10: { d: 'toothpickBox1', a: 'boradNode' },
      11: { d: 'coverBox2', a: 'cover' },
      12: { t: 'tap', n: 'faucetBox2' },
      13: { dL: ['vagetableBox11', 'vagetableBox12', 'vagetableBox13', 'vagetableBox14', 'vagetableBox15'], a: 'platformNode' },
      14: { dL: ['dishBox1', 'dishBox2', 'dishBox3', 'dishBox4', 'dishBox5'], a: 'smallDishNode' },
      15: { d: 'knifeBox1', a: 'knifeGrinder' },
      16: { d: 'knifeBox2', a: 'boradNode' },
      17: { dL: ['vagetableBox21', 'vagetableBox22', 'vagetableBox23', 'vagetableBox24', 'vagetableBox25'], a: 'boradNode' },
      18: { t: 'tap', n: 'knifeBox3' },
      19: { dL: ['vagetableBox41', 'vagetableBox42', 'vagetableBox43', 'vagetableBox44', 'vagetableBox45'], a: 'smallDishNode' },
      20: { d: 'flavourBox1', a: 'bigDishNode' },
      21: { d: 'flavourBox2', a: 'bigDishNode' },
      22: { d: 'flavourBox3', a: 'bigDishNode' },
      23: { d: 'flavourBox4', a: 'bigDishNode' },
      24: { d: 'flavourBox5', a: 'bigDishNode' },
      25: { d: 'flavourBox6', a: 'bigDishNode' },
      26: { d: 'gloveBox1', a: 'bigDishNode' },
      27: { t: 'tap', n: 'refrigeratorDoorBox1' },
      28: { d: 'bigChickenBox', a: 'refrigeratorNode' },
      29: { t: 'tap', n: 'refrigeratorDoorBox2' },
      30: { d: 'flavourBox7', a: 'bigDishNode' },
      31: { d: 'flavourBox8', a: 'bigDishNode' },
      32: { d: 'gloveBox2', a: 'bigDishNode' },
      3201: { s: 'swipe', n: 'chickenSlideBox1', dx: 90, dy: 0 },
      3202: { s: 'swipe', n: 'chickenSlideBox2', dx: -90, dy: 0 },
      33: { dL: ['appleBox1', 'appleBox2', 'appleBox3', 'appleBox4', 'appleBox5', 'appleBox6'], a: 'ironDishNode' },
      34: { d: 'toothpickBox2', a: 'ironDishNode' },
      35: { d: 'butterBox', a: 'ironDishNode' },
      36: { d: 'flavourBox9', a: 'ironDishNode' },
      37: { d: 'rubberBanBox', a: 'ironDishNode' },
      38: { d: 'tinfoilBox', a: 'ironDishNode' },
      39: { d: 'appleChickenBox1', a: 'appleDishNode' },
      40: { d: 'appleDishBox', a: 'ironDishNode' },
      41: { d: 'appleChickenBox2', a: 'ironDishNode' },
      42: { s: 'swipe', n: 'ovenDoorBox1', dx: 0, dy: -90 },
      43: { d: 'ironDishBox', a: 'ovenNode' },
      44: { s: 'swipe', n: 'ovenDoorBox2', dx: 0, dy: 90 },
      45: { t: 'tap', n: 'ovenSwitchBox' },
      46: { s: 'swipe', n: 'ovenDoorBox3', dx: 0, dy: -90 }
    };
    var ORDER = [];
    for (var i = 1; i <= 32; i++) ORDER.push(i);
    ORDER.push(3201, 3202);
    for (var j = 33; j <= 46; j++) ORDER.push(j);

    var JIT = [[0, 0], [0, 40], [0, -40], [40, 0], [-40, 0], [0, 70], [0, -70], [70, 0], [-70, 0], [0, 100], [0, -100], [100, 0], [-100, 0]];
    var tries = {};

    function firstActive(list) {
      for (var i = 0; i < list.length; i++) { var n = D(list[i]); if (act(n)) return n; }
      return null;
    }
    // ---- 17/18/19 反应式例程（这两步游戏本身不置 completed，必须看节点状态推）----
    var V2 = ['vagetableBox21', 'vagetableBox22', 'vagetableBox23', 'vagetableBox24', 'vagetableBox25'];
    var V4 = ['vagetableBox41', 'vagetableBox42', 'vagetableBox43', 'vagetableBox44', 'vagetableBox45'];
    function boardsEmpty() {
      try {
        var e1 = true, e2 = true, r1 = D('boardVagetableRoot1'), r2 = D('boardVagetableRoot2');
        if (r1) { e1 = r1.children.every(function (c) { return !c.active; }); }
        if (r2) { e2 = r2.children.every(function (c) { return !c.active; }); }
        return e1 && e2;
      } catch (e) { return true; }
    }
    function comp2(id) { if ((id === 17 || id === 18) && comp(19)) return true; return comp(id); }
    function dragHit(n, tgt) { try { return n.getBoundingBoxToWorld().intersects(tgt.getBoundingBoxToWorld()); } catch (e) { return '?'; } }
    function vegRoutine() {
      // 1) 已切好的菜 → 装盘
      var v4 = firstActive(V4);
      if (v4) {
        var dTgt = D('smallDishNode');
        if (!dTgt) return 'no smallDishNode';
        var o1 = JIT[(tries['plate'] || 0) % JIT.length];
        dragTo(v4, worldOf(dTgt), o1);
        var h1 = dragHit(v4, dTgt);
        if (h1 !== true) tries['plate'] = (tries['plate'] || 0) + 1;
        return 'plate ' + v4.name + ' hit=' + h1;
      }
      // 2) 刀可点 → 切
      var kn = D('knifeBox3');
      if (act(kn)) { tap(kn); return 'cut cur=' + C.curCuttingTimes + '/' + C.totalCuttingTimes; }
      // 3) 洗好的菜 → 上砧板（两块板全空才允许放）
      var v2 = firstActive(V2);
      if (v2) {
        if (!boardsEmpty()) return null;
        var bTgt = D('boradNode');
        if (!bTgt) return 'no boradNode';
        var o2 = JIT[(tries['board'] || 0) % JIT.length];
        dragTo(v2, worldOf(bTgt), o2);
        var h2 = dragHit(v2, bTgt);
        var still = act(v2);
        if (still) tries['board'] = (tries['board'] || 0) + 1;
        return 'board ' + v2.name + ' hit=' + h2 + ' left=' + still;
      }
      return null;
    }
    function doPlan(id) {
      var s = plan[id];
      if (!s) return 'no plan for ' + id;
      if (s.t === 'tap') {
        if (!act(D(s.n))) return 'node inactive ' + s.n;
        tap(D(s.n));
        return 'tap ' + s.n;
      }
      if (s.s === 'swipe') {
        if (!act(D(s.n))) return 'node inactive ' + s.n;
        swipeLive(D(s.n), s.dx, s.dy);
        return 'swipe ' + s.n + ' (' + s.dx + ',' + s.dy + ')';
      }
      var n = s.dL ? firstActive(s.dL) : D(s.d);
      if (!n) return 'no node ' + (s.d || s.dL.join('/'));
      if (!act(n)) return 'inactive ' + n.name;
      var tgt = D(s.a);
      if (!tgt) return 'no target ' + s.a;
      var off = JIT[(tries[id] || 0) % JIT.length];
      dragTo(n, worldOf(tgt), off);
      var ok = false;
      try { ok = n.getBoundingBoxToWorld().intersects(tgt.getBoundingBoxToWorld()); } catch (e) {}
      var nw = worldOf(n);
      return n.name + '->' + s.a + ' off(' + off.join(',') + ') hit=' + ok + ' at=' + Math.round(nw.x) + ',' + Math.round(nw.y);
    }

    function stepIdx() {
      for (var i = 0; i < ORDER.length; i++) {
        var id = ORDER[i];
        if (comp2(id)) continue;
        if ((id === 17 || id === 18) && !comp(19)) return 17; // 菜板循环：反应式处理，不看这两步的 completed
        try { if (!C.check(id)) continue; } catch (e) { continue; }
        return id;
      }
      return -1;
    }
    P.progress = function () { var a = []; for (var i = 0; i < ORDER.length; i++) if (comp(ORDER[i])) a.push(ORDER[i]); return a; };

    var lastAt = Date.now(), lastReport = 0, pendingId = -1, pendingAt = 0, lastKey = null, gapFor = null, gapAt = 0;   // 拟人节奏：换新操作停 1~3 秒
    P.timer = setInterval(function () {
      if (P.done) return;
      if (Date.now() < P.busyUntil) return;
      if (P.acting || Date.now() < (P.dragUntil || 0)) return;
      var all = true;
      for (var i = 0; i < ORDER.length; i++) { if (!comp2(ORDER[i])) { all = false; break; } }
      if (all) { P.done = true; L('ALL ' + ORDER.length + ' PARTS COMPLETED'); return; }
      var now = Date.now();
      if (now - lastReport > 15000) { lastReport = now; L('progress: ' + P.progress().join(',')); }
      if (pendingId > 0 && now - pendingAt > 2600 && !comp(pendingId)) {
        tries[pendingId] = (tries[pendingId] || 0) + 1;
        if (tries[pendingId] === 5) L('STALL #' + pendingId + ' attempts=' + tries[pendingId]);
        pendingAt = now;
      }
      if (st() !== 2) return;
      var id = stepIdx();
      if (id < 0) return;
      if (id !== lastKey) {                // 新操作：距上次动作停 1~3 秒随机
        if (gapFor !== id) { gapFor = id; gapAt = lastAt + 1000 + Math.random() * 2000; }
        if (now < gapAt) return;
      } else if (now - lastAt < 900) return;
      P.acting = true;
      var r = '';
      if (id === 17 && !comp(19)) {
        try { r = vegRoutine() || ''; } catch (e) { r = 'VEGERR ' + e.message; }
      } else {
        try { r = doPlan(id) || ''; } catch (e) { r = 'ERR ' + e.message; }
      }
      P.acting = false;
      if (r) L('act #' + id + ' ' + r + ' state=' + st());
      pendingId = id; pendingAt = now;
      lastAt = now; lastKey = id;
      P.busyUntil = now + 400;
    }, 250);
    L('L9 driver installed.. already=' + P.progress().join(','));
    return 'L9 driver running, already done: [' + P.progress().join(',') + '] state=' + st();
  };

  /* ---- L10 香蕉吐司（Level-32296，源文件 expr_lv10play.js） ---- */
  AP.drivers["Level-32296"] = function () {
  // L10 香蕉吐司 (-32296) 自动玩驱动
    // 手势规则（来自 handleTouchNode 顶部 gate）：
    //   下滑 dy<-30 = slideBox/leafBox1-3；左右滑 |dx|>30 = bananerClickBox1-7；
    //   点击 mag<15 = switchBox1；上滑 dy>30 = trayBox1；拖拽(box相交) = cj1_bananerBox→cj1_basket、dish/brush→trayNode
    var HL = window.__HLD__;
    var C = null;
    HL.findAll('Level-32296').forEach(function (c) { try { if (HL.clsName(c) === 'Level-32296') C = c; } catch (e) {} });
    if (!C) return 'no C(-32296)';
    if (window.__L10P && window.__L10P.timer) { clearInterval(window.__L10P.timer); window.__L10P.timer = null; }
    var P = window.__L10P = { log: [], t0: Date.now(), done: false, acting: false, busyUntil: 0 };
    function L() { var a = [].slice.call(arguments); P.log.push(((Date.now() - P.t0) / 1000).toFixed(1) + 's ' + a.join(' ')); if (P.log.length > 2000) P.log.splice(0, 1000); }
    function D(n) { return C.dict[n]; }
    function comp(id) { try { return !!C.partInfo[id].completed; } catch (e) { return false; } }
    function st() { return C.state; }
    function act(n) { try { return !!n && n.activeInHierarchy; } catch (e) { return false; } }

    var touch = cc.v2(0, 0), lastDelta = cc.v2(0, 0);
    function mkEv(node) {
      return {
        target: node,
        getID: function () { return 77; },
        getLocation: function () { return cc.v2(touch.x, touch.y); },
        getDelta: function () { return lastDelta; },
        stopPropagation: function () {}, stopPropagationImmediate: function () {}
      };
    }
    function worldOf(n) { return n.convertToWorldSpaceAR(cc.v2(0, 0)); }
    function beginTouch(node) { var w = worldOf(node); touch.x = w.x; touch.y = w.y; lastDelta = cc.v2(0, 0); node.emit('touchstart', mkEv(node)); }
    // 拟人拖拽：原来一瞬间拖完，现在摊到约 0.6 秒（按下微停 → 起手 → 中段快 → 落点减速）
    var DRAG_HOLD = 80, DRAG_TICK = 38;
    var DRAG_RATIO = [0.06, 0.10, 0.14, 0.18, 0.20, 0.20, 0.18, 0.16, 0.14, 0.12, 0.12, 0.14, 0.18, 0.25, 0.35, 1];
    function endTouch(node) { lastDelta = cc.v2(0, 0); node.emit('touchend', mkEv(node)); }
    function moveTick(node, targetWorld, i) {
      var want = node.parent.convertToNodeSpaceAR(targetWorld);
      var cur = node.getPosition();
      var rem = cc.v2(want.x - cur.x, want.y - cur.y);
      if (i >= DRAG_RATIO.length || rem.mag() < 0.5) { endTouch(node); return; }
      var r = DRAG_RATIO[i];
      lastDelta = cc.v2(rem.x * r, rem.y * r);
      node.emit('touchmove', mkEv(node));
      var w = worldOf(node);
      touch.x = w.x; touch.y = w.y;
      setTimeout(function () { moveTick(node, targetWorld, i + 1); }, DRAG_TICK + Math.random() * 8);
    }
    function dragTo(node, targetWorld, off) {
      var tw = targetWorld;
      if (off) tw = cc.v2(targetWorld.x + off[0], targetWorld.y + off[1]);
      beginTouch(node);
      P.dragUntil = Date.now() + 900;
      setTimeout(function () { moveTick(node, tw, 0); }, DRAG_HOLD + Math.random() * 50);
    }
    function tap(node) {
      var w = worldOf(node);
      touch.x = w.x; touch.y = w.y;
      lastDelta = cc.v2(0, 0);
      node.emit('touchstart', mkEv(node));
      // 真人点击有约 0.1 秒按压时长
      setTimeout(function () { try { lastDelta = cc.v2(0, 0); node.emit('touchend', mkEv(node)); } catch (e) {} }, 70 + Math.random() * 50);
    }
    function swipeLive(node, dx, dy) {
      var w = worldOf(node);
      touch.x = w.x; touch.y = w.y;
      lastDelta = cc.v2(0, 0);
      node.emit('touchstart', mkEv(node));
      // 快滑（甩一下）：4 帧、约 0.16 秒——真人甩手本来就快，但不是一个 0 秒瞬间
      var n = 4, k = 0;
      var tick = function () {
        if (k >= n) { lastDelta = cc.v2(0, 0); node.emit('touchend', mkEv(node)); return; }
        k++;
        touch.x = w.x + dx * k / n; touch.y = w.y + dy * k / n;
        lastDelta = cc.v2(dx / n, dy / n);
        node.emit('touchmove', mkEv(node));
        setTimeout(tick, 30 + Math.random() * 10);
      };
      setTimeout(tick, 40 + Math.random() * 25);
    }

    var plan = {
      1: { s: 'swipe', n: 'slideBox', dx: 0, dy: -90 },          // 下滑：砍下香蕉
      2: { d: 'cj1_bananerBox', a: 'cj1_basket' },                // 拖香蕉入篮
      3: { s: 'swipe', n: 'leafBox1', dx: 0, dy: -90 },           // 下滑摘叶
      4: { s: 'swipe', n: 'leafBox2', dx: 0, dy: -90 },
      5: { s: 'swipe', n: 'leafBox3', dx: 0, dy: -90 },
      6: { s: 'swipe', n: 'bananerClickBox1', dx: 90, dy: 0 },    // 左右滑切香蕉片
      7: { s: 'swipe', n: 'bananerClickBox2', dx: -90, dy: 0 },
      8: { s: 'swipe', n: 'bananerClickBox3', dx: 90, dy: 0 },
      9: { s: 'swipe', n: 'bananerClickBox4', dx: -90, dy: 0 },
      10: { s: 'swipe', n: 'bananerClickBox5', dx: 90, dy: 0 },
      11: { s: 'swipe', n: 'bananerClickBox6', dx: -90, dy: 0 },
      12: { s: 'swipe', n: 'bananerClickBox7', dx: 90, dy: 0 },
      13: { d: 'dishBox4', a: 'trayNode' },                       // 面包上托盘
      14: { d: 'brushBox1', a: 'trayNode' },                      // 刷油
      15: { d: 'dishBox5', a: 'trayNode' },                       // 放香蕉片
      16: { d: 'brushBox2', a: 'trayNode' },                      // 再刷油
      17: { d: 'dishBox3', a: 'trayNode' },                       // 撒糖
      18: { t: 'tap', n: 'switchBox1' },                          // 点开关
      19: { s: 'swipe', n: 'trayBox1', dx: 0, dy: 90 }            // 上滑入烤箱
    };
    var ORDER = [];
    for (var i = 1; i <= 19; i++) ORDER.push(i);
    var JIT = [[0, 0], [0, 40], [0, -40], [40, 0], [-40, 0], [0, 70], [0, -70], [70, 0], [-70, 0], [0, 100], [0, -100], [100, 0], [-100, 0]];
    var tries = {};

    function doPlan(id) {
      var s = plan[id];
      if (!s) return 'no plan for ' + id;
      if (s.t === 'tap') {
        var tn = D(s.n);
        if (!act(tn)) return 'node inactive ' + s.n;
        tap(tn);
        return 'tap ' + s.n;
      }
      if (s.s === 'swipe') {
        var sn = D(s.n);
        if (!act(sn)) return 'node inactive ' + s.n;
        swipeLive(sn, s.dx, s.dy);
        return 'swipe ' + s.n + ' (' + s.dx + ',' + s.dy + ')';
      }
      var n = D(s.d);
      if (!n) return 'no node ' + s.d;
      if (!act(n)) return 'inactive ' + s.d;
      var tgt = D(s.a);
      if (!tgt) return 'no target ' + s.a;
      var off = JIT[(tries[id] || 0) % JIT.length];
      dragTo(n, worldOf(tgt), off);
      var ok = false;
      try { ok = n.getBoundingBoxToWorld().intersects(tgt.getBoundingBoxToWorld()); } catch (e) {}
      var nw = worldOf(n);
      return n.name + '->' + s.a + ' off(' + off.join(',') + ') hit=' + ok + ' at=' + Math.round(nw.x) + ',' + Math.round(nw.y);
    }

    function stepIdx() {
      for (var i = 0; i < ORDER.length; i++) {
        var id = ORDER[i];
        if (comp(id)) continue;
        try { if (!C.check(id)) continue; } catch (e) { continue; }
        return id;
      }
      return -1;
    }
    P.progress = function () { var a = []; for (var i = 0; i < ORDER.length; i++) if (comp(ORDER[i])) a.push(ORDER[i]); return a; };

    var lastAt = Date.now(), lastReport = 0, pendingId = -1, pendingAt = 0, lastKey = null, gapFor = null, gapAt = 0;   // 拟人节奏：换新操作停 1~3 秒
    P.timer = setInterval(function () {
      if (P.done) return;
      if (Date.now() < P.busyUntil) return;
      if (P.acting || Date.now() < (P.dragUntil || 0)) return;
      var all = true;
      for (var i = 0; i < ORDER.length; i++) { if (!comp(ORDER[i])) { all = false; break; } }
      if (all) { P.done = true; L('ALL ' + ORDER.length + ' PARTS COMPLETED'); return; }
      var now = Date.now();
      if (now - lastReport > 15000) { lastReport = now; L('progress: ' + P.progress().join(',')); }
      if (pendingId > 0 && now - pendingAt > 2600 && !comp(pendingId)) {
        tries[pendingId] = (tries[pendingId] || 0) + 1;
        if (tries[pendingId] === 5) L('STALL #' + pendingId + ' attempts=' + tries[pendingId]);
        pendingAt = now;
      }
      if (st() !== 2) return;
      var id = stepIdx();
      if (id < 0) return;
      if (id !== lastKey) {                // 新操作：距上次动作停 1~3 秒随机
        if (gapFor !== id) { gapFor = id; gapAt = lastAt + 1000 + Math.random() * 2000; }
        if (now < gapAt) return;
      } else if (now - lastAt < 1100) return;
      P.acting = true;
      var r = '';
      try { r = doPlan(id) || ''; } catch (e) { r = 'ERR ' + e.message; }
      P.acting = false;
      L('act #' + id + ' ' + r + ' state=' + st());
      pendingId = id; pendingAt = now;
      lastAt = now; lastKey = id;
      P.busyUntil = now + 500;
    }, 250);
    L('L10 driver installed.. already=' + P.progress().join(','));
    return 'L10 driver running, already done: [' + P.progress().join(',') + '] state=' + st();
  };

  /* ====== 计划表引擎（逐字取自 probe/pt.js 的 HELPERS；计划表关共用）====== */
  var PT_SRC = "(function(){\n  var W = window;\n  var HL = W.__HLD__;\n  if (!HL) return 'no __HLD__';\n  function findLevel(){\n    var cur = null;\n    HL.findAll('Level').forEach(function(c){ var n=HL.clsName(c); if(n.indexOf('Level-')!==0) return;\n      try{ if(c.node && c.node.activeInHierarchy) cur=c; }catch(e){} });\n    return cur;\n  }\n  var T = W.__PT__ = W.__PT__ || { log: [], done: true, plan: null, t0: 0, stuck: null, acting: false };\n  T.C = null; T.timer = null;\n  T.L = function(msg){ T.log.push(((Date.now()-T.t0)/1000).toFixed(1)+'s '+msg); if(T.log.length>3000) T.log.splice(0,1500); };\n\n  // ---------- 合成触摸（对齐游戏事件模型） ----------\n  var TOUCH_ID = 0x5054;\n  var touch = cc.v2(0,0), lastDelta = cc.v2(0,0);\n  function mkEv(node){ return { target: node, getID: function(){ return TOUCH_ID; },\n    getLocation: function(){ return cc.v2(touch.x, touch.y); },\n    getDelta: function(){ return cc.v2(lastDelta.x, lastDelta.y); },\n    stopPropagation: function(){}, stopPropagationImmediate: function(){} }; }\n  function worldOf(n){ return n.convertToWorldSpaceAR(cc.v2(0,0)); }\n  function hasT(n,t){ try{ return n.hasEventListener(t); }catch(e){ return false; } }\n  function act(n){ try{ return !!(n && n.activeInHierarchy); }catch(e){ return false; } }\n  T.begin = function(n){ var w=worldOf(n); touch.x=w.x; touch.y=w.y; lastDelta=cc.v2(0,0); n.emit('touchstart', mkEv(n)); };\n  T.end   = function(n){ lastDelta=cc.v2(0,0); n.emit('touchend', mkEv(n)); };\n\n  // 目标点：优先 PolygonCollider 世界质心（A 家族），退回包围盒中心（B 家族）\n  T.targetPoint = function(name){\n    // 支持 \"节点@x,y\"：用显式世界坐标当落点（区域中心被占用时用）\n    var at = String(name).indexOf('@');\n    if (at > 0) {\n      var parts = String(name).slice(at + 1).split(',');\n      var px = Number(parts[0]), py = Number(parts[1]);\n      if (isFinite(px) && isFinite(py)) return cc.v2(px, py);\n    }\n    // 支持 \"root/i\" 与 \"root/i+dx,dy\"：取 root 第 i 个子节点包围盒中心（+偏移）。同名子节点无法按名字寻址时用（如 32016 的 7 个小碟）\n    // 支持多级：\"root/i/j\" 或 \"root/i/j+dx,dy\"（逐级下钻到第 i 个、第 j 个孩子，取包围盒中心±偏移）\n    var ss = String(name), sl = ss.indexOf('/');\n    // 支持动态选择器：\"root#child:子节点名\" —— 找 root 下第一个「某个孩子名 = 该名字且处于激活」的后代，取其中心\n    // 用途：目标位置每次都在变（如马卡龙塔要戳「还带气泡的那颗壳」）\n    var hb = ss.indexOf('#');\n    if (hb > 0) {\n      if (!T.C) T.C = findLevel();\n      var rr = T.C.dict[ss.slice(0, hb)], pick = null;\n      var spec = ss.slice(hb + 1).split(':'), specKind = spec[0], specName = spec[1] || spec[0];\n      (function scan(nd, depth) {\n        if (!nd || pick || depth > 6 || !nd.children) return;\n        for (var si = 0; si < nd.children.length; si++) {\n          var ch = nd.children[si], b = null;\n          if (specKind === 'free') {\n            try { if (ch.name === specName && ch.activeInHierarchy) { pick = ch; return; } } catch (e) {}\n          } else {\n            try { b = ch.getChildByName(specName); } catch (e) {}\n            if (b && b.activeInHierarchy) { pick = ch; return; }\n          }\n          scan(ch, depth + 1);\n          if (pick) return;\n        }\n      })(rr, 0);\n      if (pick) {\n        var pbb = pick.getBoundingBoxToWorld();\n        return cc.v2(pbb.x + pbb.width / 2, pbb.y + pbb.height / 2);\n      }\n      return null;\n    }\n    if (sl > 0) {\n      var mIdx = ss.slice(sl + 1).match(/^((?:\\d+\\/?)*)(?:\\+(-?\\d+(?:\\.\\d+)?),(-?\\d+(?:\\.\\d+)?))?$/);\n      if (mIdx) {\n        if (!T.C) T.C = findLevel();\n        var rn = T.C.dict[ss.slice(0, sl)], okc = !!rn;\n        var chain = mIdx[1].split('/').filter(function (x) { return x !== ''; });\n        for (var ci = 0; ci < chain.length; ci++) {\n          var cidx = parseInt(chain[ci], 10);\n          if (!rn || !rn.children || !rn.children[cidx]) { okc = false; break; }\n          rn = rn.children[cidx];\n        }\n        if (okc && rn) {\n          try {\n            var kbb = rn.getBoundingBoxToWorld();\n            var kox = mIdx[2] !== undefined ? Number(mIdx[2]) : 0, koy = mIdx[3] !== undefined ? Number(mIdx[3]) : 0;\n            return cc.v2(kbb.x + kbb.width / 2 + kox, kbb.y + kbb.height / 2 + koy);\n          } catch (e) {}\n        }\n      }\n    }\n    var C = T.C || (T.C = findLevel()), n = C.dict[name];\n    if (!n) return null;\n    var pts = null;\n    try {\n      var col = n.getComponent(cc.PolygonCollider);\n      if (col && col.points && col.points.length > 1) {\n        if (typeof C.getWorldPoints === 'function') pts = C.getWorldPoints(n, col.points);\n        if (!pts) { pts=[]; for (var i=0;i<col.points.length;i++){ pts.push(n.convertToWorldSpaceAR(cc.v2(col.points[i].x, col.points[i].y))); } }\n      }\n    } catch(e){}\n    if (pts && pts.length) {\n      var sx=0, sy=0; for (var j=0;j<pts.length;j++){ sx+=pts[j].x; sy+=pts[j].y; }\n      return cc.v2(sx/pts.length, sy/pts.length);\n    }\n    try { var bb = n.getBoundingBoxToWorld(); return cc.v2(bb.x+bb.width/2, bb.y+bb.height/2); } catch(e){ return null; }\n  };\n\n  // ---------- 拟人手势 ----------\n  // 节点解析：支持 \"名字\" 或 \"root/i/j\" 路径（同名节点多个时按路径取，如马卡龙 7 颗壳）\n  T.node = function(spec){\n    var ss = String(spec), sl = ss.indexOf('/'), hb = ss.indexOf('#');\n    if (hb > 0) {\n      if (!T.C) T.C = findLevel();\n      var rr2 = T.C.dict[ss.slice(0, hb)], pick2 = null;\n      var sp2 = ss.slice(hb + 1).split(':');\n      if (sp2[0] === 'find') {\n        var want2 = sp2[1];\n        (function scan(nd, depth) {\n          if (!nd || pick2 || depth > 6 || !nd.children) return;\n          for (var si = 0; si < nd.children.length; si++) {\n            var ch = nd.children[si];\n            try { if (ch.name === want2 && act(ch) && hasT(ch, 'touchstart')) { pick2 = ch; return; } } catch (e) {}\n            scan(ch, depth + 1);\n            if (pick2) return;\n          }\n        })(rr2, 0);\n      }\n      return pick2 || null;\n    }\n    if (sl > 0) {\n      if (!T.C) T.C = findLevel();\n      var rn = T.C.dict[ss.slice(0, sl)], chain = ss.slice(sl + 1).split('/');\n      for (var ci = 0; ci < chain.length; ci++) {\n        if (chain[ci] === '') continue;\n        var cidx = parseInt(chain[ci], 10);\n        if (!rn || !rn.children || !rn.children[cidx]) return null;\n        rn = rn.children[cidx];\n      }\n      return rn || null;\n    }\n    var C = T.C || (T.C = findLevel());\n    var n0 = (C && C.dict[ss]) || null;\n    if (n0 && act(n0) && hasT(n0, 'touchstart')) return n0;\n    // 同名多实例：dict 可能指向隐藏副本（如 31956 有两个 moveBox_19），扫描关内找活跃可拖实例\n    var pick = null;\n    (function scan(nd, depth) {\n      if (!nd || pick || depth > 10) return;\n      var kids = nd.children || [];\n      for (var si = 0; si < kids.length; si++) {\n        var ch = kids[si];\n        try { if (ch.name === ss && act(ch) && hasT(ch, 'touchstart')) { pick = ch; return; } } catch (e) {}\n        scan(ch, depth + 1);\n        if (pick) return;\n      }\n    })(C && C.node, 0);\n    return pick || n0;\n  };\n  var DRAG_HOLD = 80, DRAG_TICK = 38;\n  var DRAG_RATIO = [0.06,0.10,0.14,0.18,0.20,0.20,0.18,0.16,0.14,0.12,0.12,0.14,0.18,0.25,0.35,1];\n  T.drag = function(nodeName, targetName, jit, onDone){\n    var C = T.C || (T.C = findLevel()), n = T.node(nodeName);\n    if (!n) { onDone('no node '+nodeName); return; }\n    if (!act(n)) { onDone('inactive '+nodeName); return; }\n    if (!hasT(n,'touchstart')) { onDone('no listener '+nodeName); return; }\n    var w0 = T.targetPoint(targetName);\n    if (!w0) { onDone('no target '+targetName); return; }\n    var w = cc.v2(w0.x+(jit?jit[0]:0), w0.y+(jit?jit[1]:0));\n    T.dragUntil = Date.now() + 1200;\n    T.begin(n);\n    var i = 0;\n    function tick(){\n      try {\n        // 每帧重算目标（目标节点可能随场景滚动；物体可能被换父级）\n        var tw = T.targetPoint(targetName) || w;\n        tw = cc.v2(tw.x+(jit?jit[0]:0), tw.y+(jit?jit[1]:0));\n        var want = n.parent.convertToNodeSpaceAR(tw);\n        var cur = n.getPosition();\n        var rem = cc.v2(want.x-cur.x, want.y-cur.y);\n        if (i >= DRAG_RATIO.length || rem.mag() < 0.8) { T.end(n); onDone('dropped@'+Math.round(tw.x)+','+Math.round(tw.y)+' i='+i); return; }\n        var r = DRAG_RATIO[i++];\n        lastDelta = cc.v2(rem.x*r, rem.y*r);\n        n.emit('touchmove', mkEv(n));\n        var nw = worldOf(n); touch.x = nw.x; touch.y = nw.y;\n        setTimeout(tick, DRAG_TICK + Math.random()*8);\n      } catch(e){ try{ T.end(n); }catch(e2){} onDone('ERR '+e.message); }\n    }\n    setTimeout(tick, DRAG_HOLD + Math.random()*50);\n  };\n  T.tap = function(nodeName, onDone){\n    var C = T.C || (T.C = findLevel()), n = T.node(nodeName);\n    if (!n) { onDone('no node '+nodeName); return; }\n    if (!act(n)) { onDone('inactive '+nodeName); return; }\n    if (!hasT(n,'touchstart')) { onDone('no listener '+nodeName); return; }\n    T.begin(n);\n    setTimeout(function(){ try{ T.end(n); }catch(e){} onDone('tapped'); }, 70+Math.random()*50);\n  };\n  T.swipe = function(nodeName, dx, dy, onDone){\n    var C = T.C || (T.C = findLevel()), n = T.node(nodeName);\n    if (!n) { onDone('no node '+nodeName); return; }\n    if (!act(n)) { onDone('inactive '+nodeName); return; }\n    if (!hasT(n,'touchstart')) { onDone('no listener '+nodeName); return; }\n    var w = worldOf(n);\n    touch.x=w.x; touch.y=w.y; lastDelta=cc.v2(0,0);\n    T.swipeUntil = Date.now() + 600;\n    n.emit('touchstart', mkEv(n));\n    var steps=5, k=0;\n    function tick(){\n      if (k>=steps){ lastDelta=cc.v2(0,0); n.emit('touchend', mkEv(n)); onDone('swiped'); return; }\n      k++;\n      touch.x = w.x + dx*k/steps; touch.y = w.y + dy*k/steps;\n      lastDelta = cc.v2(dx/steps, dy/steps);\n      n.emit('touchmove', mkEv(n));\n      setTimeout(tick, 30+Math.random()*10);\n    }\n    setTimeout(tick, 40+Math.random()*25);\n  };\n  T.hold = function(nodeName, ms, onDone){\n    var C = T.C || (T.C = findLevel()), n = C.dict[nodeName];\n    if (!n) { onDone('no node '+nodeName); return; }\n    if (!act(n)) { onDone('inactive '+nodeName); return; }\n    T.begin(n);\n    T.dragUntil = Date.now() + ms;\n    setTimeout(function(){ try{ T.end(n); }catch(e){} onDone('held '+ms); }, ms);\n  };\n  // 搅拌（32016 碗内搅拌等）：按住节点做圆周滑动，每次 move 都满足游戏 \"位移>5\" 判定\n  T.stir = function(nodeName, doneFn, onDone){\n    var C = T.C || (T.C = findLevel()), n = C.dict[nodeName];\n    if (!n) { onDone('no node '+nodeName); return; }\n    if (!act(n)) { onDone('inactive '+nodeName); return; }\n    if (!hasT(n,'touchstart')) { onDone('no listener '+nodeName); return; }\n    var R = (T.plan.opts&&T.plan.opts.stirRadius)||70;\n    var maxMs = (T.plan.opts&&T.plan.opts.stirMs)||45000;\n    var t0 = Date.now(), i = 0;\n    T.begin(n);                       // touchstart 落在节点世界中心\n    var w = worldOf(n);\n    T.dragUntil = Date.now() + 99999;\n    (function tick(){\n      if (T.done || (doneFn && doneFn()) || Date.now()-t0 > maxMs) {\n        T.dragUntil = 0; try{ T.end(n); }catch(e){}\n        onDone('stir x'+i+(doneFn&&doneFn()?' done':''));\n        return;\n      }\n      i++;\n      var a0 = (i-1)*0.5, a1 = i*0.5;\n      touch.x = w.x + Math.cos(a1)*R; touch.y = w.y + Math.sin(a1)*R;\n      lastDelta = cc.v2(Math.cos(a1)*R-Math.cos(a0)*R, Math.sin(a1)*R-Math.sin(a0)*R);\n      n.emit('touchmove', mkEv(n));\n      setTimeout(tick, 22+Math.random()*14);\n    })();\n  };\n  T.knife = function(nodeName, doneFn, onDone){\n    var C = T.C || (T.C = findLevel()), n = C.dict[nodeName] || C.dict['knifeBox3'];\n    if (!n || !act(n) || !hasT(n,'touchstart')) {\n      // 兜底：找任一激活 knifeBox\n      Object.keys(C.dict).some(function(nm){ var m=C.dict[nm];\n        if (/^knifeBox/.test(nm) && act(m) && hasT(m,'touchstart')) { n=m; return true; } return false; });\n    }\n    if (!n || !act(n) || !hasT(n,'touchstart')) { onDone('no active knife'); return; }\n    var cad = (T.plan.opts&&T.plan.opts.knifeCadence)||300;\n    var max = (T.plan.opts&&T.plan.opts.knifeMax)||80;\n    var taps = 0;\n    T.dragUntil = Date.now() + 99999;   // 切菜期间锁住其它动作\n    (function next(){\n      if (T.done || taps>=max || (doneFn && doneFn())) { T.dragUntil = 0; onDone('knife x'+taps+' '+(doneFn&&doneFn()?'done':'')); return; }\n      taps++;\n      T.begin(n);\n      setTimeout(function(){\n        try{ T.end(n); }catch(e){}\n        setTimeout(next, cad);\n      }, 70+Math.random()*40);\n    })();\n  };\n  // 等待态门控：显式 waitTouch（缺省 2）+ 运行时自适应补入。\n  // 旧计划表遇到新引擎（或相反）时状态枚举可能不同，硬等会空转到超时；\n  // 这里允许「同一状态持续 N 秒」时把该状态也视为可动手，并打日志便于事后回填计划表。\n  function wtList(){ var o=(T.plan&&T.plan.opts)||{}; if(!o.__wts) o.__wts=[(o.waitTouch===undefined?2:o.waitTouch)]; return o.__wts; }\n  function wtOK(v){ var a=wtList(); for(var i=0;i<a.length;i++) if(a[i]===v) return true; return false; }\n  function wtAdopt(v,tag){ var a=wtList(); if(a.indexOf(v)<0){ a.push(v); try{ T.L('  '+tag+'：门控自适应，接受 state='+v+'（允许集 '+a.join('/')+'）'); }catch(e){} } }\n  function wtGateBlocked(holder,key,v,stableMs,tag){\n    var g=holder[key]||(holder[key]={val:null,since:0});\n    if(g.val!==v){ g.val=v; g.since=Date.now(); return false; }\n    if(Date.now()-g.since>stableMs){ wtAdopt(v,tag); g.val=null; g.since=0; return false; }\n    return true;\n  }\n  // 切割循环：整关 isJichi（刀切肉）→ 右滑；否则点按。每次一刀，直到该步完成。\n  T.cuts = function(nodeName, doneFn, onDone){\n    var C = T.C || (T.C = findLevel()), n = C.dict[nodeName] || C.dict['knifeBox3'];\n    var max = (T.plan.opts&&T.plan.opts.cutMax)||40;\n    var cad = (T.plan.opts&&T.plan.opts.cutCadence)||700;\n    var deadline = Date.now() + ((T.plan.opts&&T.plan.opts.cutTimeoutMs)||90000);\n    var att = 0;\n    var drRetry = false, sawFood = false;\n    T.dragUntil = Date.now() + 99999;\n    (function next(){\n      if (T.done || att>=max || (doneFn && doneFn())) { T.dragUntil = 0; onDone('cuts x'+att+(doneFn&&doneFn()?' done':'')); return; }\n      if (Date.now() > deadline) { T.dragUntil = 0; onDone('cuts timeout x'+att); return; }\n      var jichi = false, temp = -1;\n      var st = -1, food = undefined;\n      try{ jichi = !!C.isJichi; temp = C.tempNum; st = C._state; }catch(e){}\n      try{ food = C.curCuttingFood; }catch(e){ food = undefined; }\n      var armed = !!(n && act(n) && hasT(n,'touchstart'));\n      // curCuttingVagetable 型关卡（32016）：切完当前菜后节点被置 null，继续点会崩游戏\n      var veg = undefined; try{ veg = C.curCuttingVagetable; }catch(e){ veg = undefined; }\n      if (veg === null && att === 0 && !(n && act(n) && hasT(n,'touchstart'))) { T.dragUntil = 0; onDone('cuts x0 veg-none'); return; }\n      if (veg !== undefined) {\n        if (veg === null || !act(veg)) {\n          if (att > 0) { T.dragUntil = 0; onDone('cuts x'+att+' veg-done'); return; }\n          setTimeout(next, 250); return;   // 菜还没上板：等\n        }\n      }\n      // jichi 整轮切完：刀收回去（knifeBox 失活）且 tempNum 已归零\n      if (!armed && jichi && att>2 && temp===0) { T.dragUntil = 0; onDone('cuts x'+att+' knife-back'); return; }\n      if (!armed) {\n        if (att > 0) {\n          if (drRetry) { T.dragUntil = 0; onDone('cuts x'+att+' knife-inactive'); return; }\n          drRetry = true;\n          setTimeout(next, 700);\n          return;\n        }\n        setTimeout(next, 300); return;\n      }\n      drRetry = false;\n      if (att > 0 && food !== undefined) {\n        if (food && act(food)) sawFood = true;\n        else if (sawFood) { T.dragUntil = 0; onDone('cuts x'+att+' food-gone'); return; }\n      }\n      if (st !== -1 && !wtOK(st)) {\n        if (!T._wtHold) T._wtHold = {};\n        if (wtGateBlocked(T._wtHold,'cutGate',st,4000,'cuts')) { setTimeout(next, 200); return; }\n      }\n      T._wtHold = null;\n      att++;\n      if (jichi) {\n        T.swipe(nodeName, 90, 0, function(){ setTimeout(next, cad); });\n      } else {\n        T.begin(n);\n        setTimeout(function(){ try{ T.end(n); }catch(e){} setTimeout(next, cad); }, 70+Math.random()*40);\n      }\n    })();\n  };\n\n  // ---------- 步骤执行 ----------\n  // 重新上刀：刀不在板上（knifeBox3 失活）时，用游戏自己的逻辑把刀摆回当前食材\n  T.armknife = function(onDone){\n    var C = T.C || (T.C = findLevel());\n    var kb = C.dict['knifeBox3'];\n    if (kb && act(kb) && hasT(kb,'touchstart')) { onDone('knife already armed'); return; }\n    try {\n      if (C.dict['knifeSk2']) C.dict['knifeSk2'].active = true;\n      if (C.caibanIsHasFood) {\n        if (C.isJichi) C.showKnife2(C.caibanFoodId); else C.showKnife(C.caibanFoodId);\n      }\n    } catch(e){ onDone('armknife ERR '+e.message); return; }\n    setTimeout(function(){ onDone('armed kb='+!!(kb&&act(kb))); }, 650);\n  };\n\n  // 等游戏内部标志位为真再动手（例：钓鱼 _isHasFish/_isHasShark 咬钩窗口）\n  T.untilFlag = function(flags, timeoutMs, cb){\n    var t0 = Date.now();\n    (function poll(){\n      if (T.done) { cb('until-abort'); return; }\n      var ok = false;\n      try { for (var i=0;i<flags.length;i++) if (T.C[flags[i]]) { ok = true; break; } } catch(e){}\n      if (ok) { cb('flag-on'); return; }\n      if (Date.now() - t0 > timeoutMs) { cb('until-timeout'); return; }\n      setTimeout(poll, 160);\n    })();\n  };\n\n  function comp(k){\n    var s = (T.plan && T.plan.steps && T.plan.steps[k]) || null;\n    if (s) {\n      try {\n        if (s.notDoneExpr) {\n          T._ndFn = T._ndFn || {};\n          var fnd = T._ndFn[k];\n          if (!fnd) fnd = T._ndFn[k] = new Function('C', 'return (' + s.notDoneExpr + ');');\n          if (fnd(T.C)) return false;\n        }\n        if (s.doneBoardLte !== undefined) {\n          var b = T.C.dict[(s.doneBoardRoot || 'boardFoodRoot1')];\n          if (b && b.childrenCount <= s.doneBoardLte) return true;\n        }\n        if (s.doneSceneGte !== undefined && T.C.level_makingStep >= s.doneSceneGte) return true;\n        if (s.doneFlag && T.C[s.doneFlag]) return true;\n        if (s.doneExpr) {\n          T._deFn = T._deFn || {};\n          var fe = T._deFn[k];\n          if (!fe) fe = T._deFn[k] = new Function('C', 'return (' + s.doneExpr + ');');\n          if (fe(T.C)) return true;\n        }\n      } catch(e){}\n    }\n    try{ return !!(T.C.partInfo[k] && T.C.partInfo[k].completed); }catch(e){ return false; }\n  }\n  T.comp = comp;\n  function stateVal(){ try{ var v=T.C._state; if (v===undefined) v=T.C.state; return v; }catch(e){ return -1; } }\n  function tipOf(k){ try{ return ((T.C._touchList||[])[k-1]||{}).tips||''; }catch(e){ return ''; } }\n  function listeners(){\n    var out = [];\n    try { Object.keys(T.C.dict||{}).forEach(function(nm){ var n=T.C.dict[nm];\n      if (!n || n==='null' || !act(n)) return;\n      var t=hasT(n,'touchstart')||hasT(n,'touchmove')||hasT(n,'touchend');\n      if (t) out.push(nm); }); } catch(e){}\n    return out;\n  }\n  T.stepKeys = function(){\n    if (T.plan && T.plan.order && T.plan.order.length) return T.plan.order.slice();\n    var ks = Object.keys(T.plan.steps||{}).map(Number).sort(function(a,b){return a-b;});\n    return ks;\n  };\n  function nextK(){\n    var ks = T.stepKeys();\n    for (var i=0;i<ks.length;i++) { if (!comp(ks[i])) return ks[i]; }\n    return -1;\n  }\n  T.nextK = nextK;\n  T.progress = function(){ var a=[]; var ks=T.stepKeys(); for(var i=0;i<ks.length;i++){ if(comp(ks[i])) a.push(ks[i]); } return a; };\n\n  var st = { curK: -1, tries: 0, actAt: 0, lastActAt: 0, waitingSince: 0 };\n  T.st = st;\n\n  function describe(k){\n    var s = T.plan.steps[k]; if (!s) return 'no entry';\n    var parts = [];\n    if (s.wait) parts.push('wait(auto)');\n    if (s.d) parts.push('drag '+s.d[0]+'->'+s.d[1]);\n    if (s.t) parts.push('tap '+s.t);\n    if (s.knife) parts.push('knife '+s.knife);\n    if (s.cuts) parts.push('cuts '+s.cuts);\n    if (s.sw) parts.push('swipe '+s.sw[0]+' ('+s.sw[1]+','+s.sw[2]+')');\n    if (s.h) parts.push('hold '+s.h[0]+' '+s.h[1]+'ms');\n    if (s.acts) parts.push('acts['+s.acts.length+']');\n    if (s.stir) parts.push('stir '+s.stir);\n    if (s.sleep) parts.push('sleep '+s.sleep+'ms');\n    if (s.fsh) parts.push('fishing-wait '+s.fsh);\n    return parts.join(' + ');\n  }\n  T.describe = describe;\n\n  function doAction(k, after){\n    var s = T.plan.steps[k] || {};\n    var opts = T.plan.opts || {};\n    var jitList = s.jits || opts.jits || [[0,0],[0,40],[0,-40],[40,0],[-40,0],[0,70],[0,-70],[70,0],[-70,0],[0,100],[0,-100],[100,0],[-100,0]];\n    var jit = jitList[(st.tries-1) % jitList.length];\n    var results = [];\n    function full(msg){ results.push(msg); after(results.join(' | ')); }\n    if (s.wait) { full('wait-only'); return; }\n    var queue = [];\n    if (s.acts) { queue = s.acts.slice(); }\n    else { queue = [s]; }\n    (function runOne(){\n      var a = queue.shift();\n      if (!a) { full('done'); return; }\n      var cb = function(msg){\n        results.push(msg);\n        if (queue.length) setTimeout(runOne, 420); else full('done');\n      };\n      if (a.d) T.drag(a.d[0], a.d[1], jit, cb);\n      else if (a.t) T.tap(a.t, cb);\n      else if (a.knife) T.knife(a.knife, function(){ return comp(k); }, cb);\n      else if (a.cuts) {\n        var cutFn = function(){ return comp(k); };\n        if (s.cutDone) {\n          try {\n            var fcd = T._deFn['c'+k];\n            if (!fcd) fcd = T._deFn['c'+k] = new Function('C', 'return (' + s.cutDone + ');');\n            cutFn = function(){ try { return !!fcd(T.C); } catch(e){ return false; } };\n          } catch(e){}\n        }\n        T.cuts(a.cuts, cutFn, cb);\n      }\n      else if (a.armknife) T.armknife(cb);\n      else if (a.sw) T.swipe(a.sw[0], a.sw[1], a.sw[2], cb);\n      else if (a.h) T.hold(a.h[0], a.h[1], cb);\n      else if (a.stir) T.stir(a.stir, function(){ return comp(k); }, cb);\n      else if (a.sleep) setTimeout(function(){ cb('sleep '+a.sleep); }, a.sleep);\n      else if (a.fsh) T.untilFlag(a.fshFlags || ['_isHasFish','_isHasShark'], a.fshTimeout || 30000, function(msg){\n        if (msg === 'flag-on') T.swipe(a.fsh, a.fshDx||0, a.fshDy===undefined?250:a.fshDy, cb); else cb(msg);\n      });\n      else if (a.wait) cb('wait-sub');\n      else cb('empty-sub');\n    })();\n  }\n\n  T.tick = function(){\n    if (T.done) return;\n    T.C = T.C || findLevel();\n    var C = T.C || (T.C = findLevel());\n    if (!C || !act(C.node)) { C = T.C = findLevel(); if (!C) return; }\n    try { if (W.__AUTOPLAY__ && W.__AUTOPLAY__.state) W.__AUTOPLAY__.state.levelAt = Date.now(); } catch(e){}  // 防 6 分钟跳过兜底\n    var opts = T.plan.opts || {};\n    var settle = opts.settleMs || 2600;\n    var k = nextK();\n    if (k < 0) { T.done = true; T.L('ALL DONE '+T.stepKeys().length+' steps, '+((Date.now()-T.t0)/1000).toFixed(1)+'s'); return; }\n    var busy = T.acting || Date.now() < (T.dragUntil||0);\n    if (k !== st.curK && !busy) {\n      st.curK = k; st.tries = 0; st.waitingSince = Date.now();\n      var gap = 1000 + Math.random()*2000;\n      st.actAt = Date.now() + gap;\n      T.L('→ 第'+k+'步 ['+describe(k)+']'+(tipOf(k)?' 提示:'+tipOf(k):'')+' state='+stateVal());\n    }\n    if (busy) return;\n    var now = Date.now();\n    if (now < st.actAt) return;\n    // 等待型步骤（或无动作步骤）：只等\n    var s = T.plan.steps[k] || {};\n    if (s.wait || !(s.d||s.t||s.knife||s.cuts||s.sw||s.h||s.acts||s.fsh||s.stir||s.sleep)) {\n      if (now - st.actAt > (opts.autoWaitMs||25000)) {\n        T.stuck = { k:k, why:'auto-step timeout', active:listeners(), state:stateVal() };\n        T.L('✗ 卡在第'+k+'步（自动步骤超时）state='+stateVal()+' 监听中: '+listeners().join(','));\n        T.done = true;\n      }\n      return;\n    }\n    // 有动作步骤\n    var maxTries = (T.plan.steps[k] && T.plan.steps[k].maxTries) || opts.maxTries || 6;\n    if (st.tries >= maxTries) {\n      T.stuck = { k:k, why:'max tries', active:listeners(), state:stateVal(), desc:describe(k) };\n      T.L('✗ 卡在第'+k+'步（'+describe(k)+' 试了'+st.tries+'次）state='+stateVal()+' 监听中: '+listeners().join(','));\n      if (opts.force) { st.curK = -2; st.tries = 0; return; }\n      T.done = true;\n      return;\n    }\n    if (st.tries > 0 && now - st.lastActAt < settle) return;\n    // 节点可用性检查\n    // 多动作步骤(acts)/切割(cuts)不做节点预检，交给动作自己处理（drag 会跳过 inactive 并继续）\n    var probeName = s.acts || s.cuts || s.armknife || s.fsh ? null : ((s.d && s.d[0]) || s.t || s.knife || (s.sw && s.sw[0]) || (s.h && s.h[0]) || s.stir);\n    var node = probeName ? T.node(probeName) : null;\n    if (node && (!act(node) || !hasT(node,'touchstart'))) {\n      if (now - st.waitingSince > 15000 && st.tries === 0) {\n        T.L('… 第'+k+'步节点 '+probeName+' 未激活（active='+act(node)+' listener='+hasT(node,'touchstart')+'）state='+stateVal());\n        st.waitingSince = now;\n      }\n      return;\n    }\n    // stateGate：等游戏回到 waitTouch 再动手（默认 2，个别关卡枚举不同用 opts.waitTouch 指定；\n    // 同一状态稳定超过 6 秒 → 自适应接受，避免旧计划表配新引擎时空转）\n    if (opts.stateGate) {\n      var svv = stateVal();\n      if (svv !== -1 && !wtOK(svv)) {\n        if (!st.wtHold) st.wtHold = {};\n        var blocked = wtGateBlocked(st.wtHold,'gate',svv,6000,'stateGate');\n        if (!st.gateLog || now - st.gateLog > 5000) { st.gateLog = now; T.L('  等动画 state=' + svv + ' #' + k + ' 目标=' + wtList().join('/') + (blocked?'（等待中）':'（已自适应）')); }\n        if (blocked) return;\n      }\n    }\n    st.tries++;\n    st.lastActAt = now;\n    T.L('  执行 #'+k+' 第'+st.tries+'次 ['+describe(k)+'] state='+stateVal());\n    T.acting = true;\n    doAction(k, function(msg){\n      T.acting = false;\n      T.L('  动作完成 #'+k+': '+msg);\n      st.actAt = Date.now() + 200;  // 动作后稍等再判定\n    });\n  };\n\n  T.start = function(plan){\n    var myGen = (T.gen || 0) + 1;\n    T.gen = myGen;\n    T.stop = function(){ T.gen++; if (T.timer) clearInterval(T.timer); T.timer = null; T.done = true; return 'stopped'; };\n    if (T.timer) { clearInterval(T.timer); T.timer = null; }\n    T.plan = plan; T.log = []; T.done = false; T.stuck = null; T.acting = false; T._deFn = {}; T._ndFn = {};\n    T.t0 = Date.now(); st.curK = -1; st.tries = 0;\n    T.C = findLevel();\n    if (!T.C) { T.L('no active level'); T.done = true; return 'no level'; }\n    T.timer = setInterval(function(){ if (T.gen !== myGen) return; try{ T.tick(); }catch(e){ T.L('tick ERR '+e.message); } }, 200);\n    T.L('开始执行计划 '+plan.cls+' 共'+T.stepKeys().length+'步; 已完成:['+T.progress().join(',')+']');\n    return 'started';\n  };\n  return 'pt helpers ok';\n})()";
  function ensurePT() {
    if (W.__PT__ && W.__PT__.start) { return W.__PT__; }
    try { (new Function(PT_SRC))(); } catch (e) { return null; }
    return W.__PT__ || null;
  }
  AP.ensurePT = ensurePT;

  /* ---- L11 黑椒牛柳意面（Level-32003，计划表 plans/plan32003.auto.json，25 步） ---- */
  var PLAN_L32003 = {"cls":"Level-32003","_generated":"2026-10-06T12:34:39.540Z","opts":{"maxTries":5,"settleMs":2600,"cutMax":40,"cutCadence":700,"cutTimeoutMs":60000},"steps":{"1":{"d":["knifeBox","boradNode"]},"2":{"acts":[{"d":["foodBox11","boradNode"]},{"cuts":"knifeBox2"}],"doneBoardLte":3},"3":{"acts":[{"d":["foodBox12","boradNode"]},{"cuts":"knifeBox2"}],"doneBoardLte":2},"4":{"acts":[{"d":["foodBox13","boradNode"]},{"cuts":"knifeBox2"}],"doneBoardLte":1},"5":{"acts":[{"d":["foodBox14","boradNode"]},{"cuts":"knifeBox2"}],"doneBoardLte":0},"6":{"wait":true,"doneSceneGte":2},"7":{"t":"switchBox1"},"8":{"d":["cupBox1","potNode"]},"9":{"d":["rawNoodleBox","potNode"]},"10":{"d":["cupBox2","cj3_dish3"]},"11":{"d":["potNoodleBox","cj3_dish3"]},"12":{"d":["brushBox1","potNode"]},"13":{"d":["cj3_foodBox1_1","potNode"]},"14":{"acts":[{"d":["turnerBox","potNode"]},{"cuts":"fryBox1"}]},"15":{"d":["potFoodBox1","cj3_dish2"]},"16":{"d":["brushBox2","potNode"]},"17":{"d":["cj3_foodBox2_1","potNode"]},"18":{"d":["cj3_flavourBox1","potNode"]},"19":{"d":["cj3_flavourBox2","potNode"]},"20":{"acts":[{"d":["turnerBox","potNode"]},{"cuts":"fryBox2"}]},"21":{"d":["cj3_foodBox1_2","potNode"]},"22":{"d":["bowlNoodleBox","potNode"]},"23":{"acts":[{"d":["turnerBox","potNode"]},{"cuts":"fryBox3"}]},"24":{"d":["potPastaBox","cj3_dish4"]},"25":{"t":"switchBox2"}}};
  AP.drivers["Level-32003"] = function () {
    var T = ensurePT();
    if (!T) { return '计划引擎未就绪'; }
    return T.start(PLAN_L32003);
  };

  /* ---- L12 寿司卷（Level-31956，计划表 plans/plan31956.auto.json，73 步） ---- */
  var PLAN_L31956 = {"cls":"Level-31956","_note":"寿司卷 73 步（tips 表 + case 逆向）v1 2026-10-06 晚","opts":{"maxTries":6,"settleMs":2600,"cutMax":60,"cutCadence":700,"cutTimeoutMs":120000,"stateGate":true,"waitTouch":3},"order":11,"steps":{"1":{"d":["moveBox_1","area_1"]},"2":{"d":["moveBox_2","area_2"]},"3":{"d":["moveBox_3","area_3"]},"4":{"d":["moveBox_4","area_4"]},"5":{"d":["moveBox_5","area_3"]},"6":{"d":["moveBox_4","area_6"]},"7":{"sw":["slideBox_7",0,90]},"8":{"t":"clickBox_8"},"9":{"t":"clickBox_9"},"10":{"acts":[{"d":["moveBox_jidan1","area_wan"]},{"d":["moveBox_danhuang","area_wan"]},{"d":["moveBox_jidan2","area_wan"]},{"d":["moveBox_danhuang","area_wan"]}]},"11":{"d":["moveBox_11","area_yanwan1"]},"12":{"d":["moveBox_12","area_yanwan2"]},"13":{"d":["moveBox_13","area_wan1"]},"14":{"d":["moveBox_14","area_wan2"]},"15":{"t":"clickBox_15"},"16":{"d":["moveBox_16","area_guo"]},"17":{"d":["moveBox_17","area_guo"]},"18":{"d":["moveBox_18","area_guo"]},"19":{"d":["moveBox_19","area_guo"]},"20":{"d":["moveBox_18","area_guo"]},"21":{"d":["moveBox_21","area_caiban"]},"22":{"d":["moveBox_22","area_caiban"]},"23":{"cuts":"knifeBox3"},"24":{"d":["moveBox_24","area_panzi"]},"25":{"d":["moveBox_25","area_caiban"]},"26":{"cuts":"knifeBox3"},"27":{"d":["moveBox_27","area_panzi"]},"28":{"d":["moveBox_28","area_caiban"]},"29":{"cuts":"knifeBox3"},"30":{"d":["moveBox_30","area_panzi"]},"31":{"d":["moveBox_31","area_caiban"]},"32":{"cuts":"knifeBox3"},"33":{"d":["moveBox_33","area_panzi"]},"34":{"d":["moveBox_34","area_caiban"]},"35":{"cuts":"knifeBox3"},"36":{"d":["moveBox_36","area_panzi"]},"37":{"d":["moveBox_37","area_caiban"]},"38":{"cuts":"knifeBox3"},"39":{"d":["moveBox_39","area_panzi"]},"40":{"d":["moveBox_40","area_caiban"]},"41":{"cuts":"knifeBox3"},"42":{"d":["moveBox_42","area_panzi"]},"43":{"d":["moveBox_zicai","area_zhulian"]},"44":{"d":["moveBox_44","area_zhulian"]},"45":{"sw":["slideBox_zicaijuan",-250,0]},"46":{"d":["moveBox_zicai","area_zhulian"],"doneExpr":"C.zhulianIsHasZicai===true"},"47":{"d":["moveBox_47","area_zhulian"]},"48":{"sw":["slideBox_zicaijuan",-250,0]},"49":{"d":["moveBox_zicai","area_zhulian"],"doneExpr":"C.zhulianIsHasZicai===true"},"50":{"d":["moveBox_50","area_zhulian"]},"51":{"sw":["slideBox_zicaijuan",-250,0]},"52":{"d":["moveBox_zicai","area_zhulian"],"doneExpr":"C.zhulianIsHasZicai===true"},"53":{"d":["moveBox_53","area_zhulian"]},"54":{"sw":["slideBox_zicaijuan",-250,0]},"55":{"d":["moveBox_zicai","area_zhulian"],"doneExpr":"C.zhulianIsHasZicai===true"},"56":{"d":["moveBox_56","area_zhulian"]},"57":{"sw":["slideBox_zicaijuan",-250,0]},"58":{"d":["moveBox_zicai","area_zhulian"],"doneExpr":"C.zhulianIsHasZicai===true"},"59":{"d":["moveBox_59","area_zhulian"]},"60":{"sw":["slideBox_zicaijuan",-250,0]},"61":{"d":["moveBox_zicai","area_zhulian"],"doneExpr":"C.zhulianIsHasZicai===true"},"62":{"d":["moveBox_62","area_zhulian"]},"63":{"sw":["slideBox_zicaijuan",-250,0]},"64":{"d":["moveBox_zicai","area_zhulian"],"doneExpr":"C.zhulianIsHasZicai===true"},"65":{"d":["moveBox_65","area_zhulian"]},"66":{"sw":["slideBox_zicaijuan",-250,0]},"67":{"d":["moveBox_zicai","area_zhulian"],"doneExpr":"C.zhulianIsHasZicai===true"},"68":{"d":["moveBox_68","area_zhulian"]},"69":{"sw":["slideBox_69",-250,0]},"70":{"acts":[{"d":["moveBox_70","area_zhulian"]},{"cuts":"knifeBox4"}],"cutDone":"C.curCuttingVagetable===null || C.curCuttingVagetable===undefined","notDoneExpr":"C.curCuttingVagetable!==null && C.curCuttingVagetable!==undefined"},"71":{"d":["moveBox_71","area_71"]},"72":{"d":["moveBox_72","area_72"]},"73":{"acts":[{"d":["scMoveBox_1","area_73"]},{"d":["scMoveBox_2","area_73"]},{"d":["scMoveBox_3","area_73"]},{"d":["scMoveBox_4","area_73"]},{"d":["scMoveBox_5","area_73"]},{"d":["scMoveBox_6","area_73"]},{"d":["scMoveBox_7","area_73"]},{"d":["scMoveBox_8","area_73"]}],"maxTries":8}}};
  AP.drivers["Level-31956"] = function () {
    var T = ensurePT();
    if (!T) { return '计划引擎未就绪'; }
    return T.start(PLAN_L31956);
  };

  /* ---- L13 榛子冰淇淋（Level-32001，计划表 plans/plan32001.auto.json，60 步） ---- */
  var PLAN_L32001 = {"cls":"Level-32001","_note":"榛子冰淇淋 v3 2026-10-06（v1 + 校验器修 order 显式数组 / 步231 补 doneExpr；步19 实测：tap diancilu_switch 仍是正解，v2 的 wait 改动已回退——按钮点后 active 仍为 true，点击即推进 3→4 幕）。死号：19=搅拌4次+关炉、27=场景4关炉、17.5=倒锅、18.1-18.4=搅拌机4次、26.5=复合232425、451=玻璃杯倒锅、47=自动出冰淇淋、48-51=舀4勺、52=等通关","order":["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","17.5","18","18.1","18.2","18.3","18.4","19","20","21","22","23","231","24","25","26","26.5","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","451","45","46","47","48","49","50","51","52"],"opts":{"maxTries":6,"settleMs":2600,"stateGate":true,"waitTouch":2,"autoWaitMs":40000},"steps":{"1":{"d":["egg","wan_red"]},"2":{"d":["egg2","wan_red"]},"3":{"d":["egg3","wan_red"]},"4":{"d":["niunai","beizi"]},"5":{"sw":["weibolu_open_btn",-150,0]},"6":{"d":["beizi_niunai","weibolu/6"]},"7":{"sw":["weibolu_close_btn",150,0]},"8":{"t":"weibolu_switch_btn"},"9":{"d":["hongtang","wan_red"]},"10":{"d":["beizi_niunai2","wan_red"]},"11":{"d":["dadanqi","wan_red"]},"12":{"d":["dannaiyou","wan_blue"]},"13":{"d":["lianru","wan_blue"]},"14":{"d":["s2_dadanqi","wan_blue"]},"15":{"t":"diancilu_switch"},"16":{"d":["s3_wan_red","diancilu"]},"17":{"d":["loushao","s3_wan_purple"]},"18":{"d":["guochan","s3_wan_purple"]},"19":{"t":"diancilu_switch","doneExpr":"C.currSceneIndex>=4"},"20":{"acts":[{"t":"s4_diancilu_switch"},{"d":["water","guoCheck"]}]},"21":{"d":["chocolate","s4_wan_red"]},"22":{"d":["s4_milk","s4_wan_red"]},"23":{"d":["s4_wan_red","guoCheck"]},"24":{"d":["jiazi","guoCheck"]},"25":{"d":["s4_wan_purple","s4_wan_red3"]},"26":{"d":["s4_wan_blue","s4_wan_red3"]},"27":{"t":"s4_diancilu_switch","doneExpr":"C.currSceneIndex>=5"},"28":{"d":["s5_wan_red","biaohuadai"]},"29":{"d":["gunzi","moju"]},"30":{"d":["gunzi2","moju"]},"31":{"d":["gunzi3","moju"]},"32":{"d":["gunzi4","moju"]},"33":{"d":["biaohuadai3","moju"]},"34":{"d":["biaohuadai3","moju"]},"35":{"d":["biaohuadai3","moju"]},"36":{"d":["biaohuadai3","moju"]},"37":{"sw":["bingxiang_box",150,0]},"38":{"d":["moju","bingxiang"]},"39":{"sw":["bingxiang_box",-150,0]},"40":{"t":"s6_diancilu_switch"},"41":{"d":["s6_water","s6_guoCheck"]},"42":{"d":["s6_jianguosui","s6_bolibei"]},"43":{"d":["s6_chocolate","s6_bolibei"]},"44":{"d":["s6_kekezhi","s6_bolibei"]},"45":{"d":["s6_shaozi","s6_bolibei"]},"46":{"d":["s6_jiazi","s6_bolibei2"]},"47":{"wait":true,"doneExpr":"C.finishSet.has(47)"},"48":{"acts":[{"t":"s6_diancilu_switch"},{"d":["xg1","s6_bolibei3"]},{"sw":["xg1-a",0,-90]}],"doneExpr":"C.finishSet.has(48)"},"49":{"acts":[{"d":["xg2","s6_bolibei3"]},{"sw":["xg2-a",0,-90]}],"doneExpr":"C.finishSet.has(49)"},"50":{"acts":[{"d":["xg3","s6_bolibei3"]},{"sw":["xg3-a",0,-90]}],"doneExpr":"C.finishSet.has(50)"},"51":{"acts":[{"d":["xg4","s6_bolibei3"]},{"sw":["xg4-a",0,-90]}],"doneExpr":"C.finishSet.has(51)"},"52":{"wait":true,"doneExpr":"C.currSceneIndex>=7||C._state===4"},"231":{"d":["s4_guochan","guoCheck"],"doneExpr":"C.finishSet.has(231)"},"451":{"d":["s6_bolibei","s6_guoCheck"],"doneExpr":"C.finishSet.has(451)"},"17.5":{"d":["guo","s3_wan_purple"],"doneExpr":"C.dict['guo']&&C.dict['guo'][C.mIsFinish]===true"},"18.1":{"sw":["cj2_chanzi_tongyong_move",0,90],"doneExpr":"C.dict['cj2_chanzi_tongyong_move']&&C.dict['cj2_chanzi_tongyong_move'][C.mCounter]>=1"},"18.2":{"sw":["cj2_chanzi_tongyong_move",0,90],"doneExpr":"C.dict['cj2_chanzi_tongyong_move']&&C.dict['cj2_chanzi_tongyong_move'][C.mCounter]>=2"},"18.3":{"sw":["cj2_chanzi_tongyong_move",0,90],"doneExpr":"C.dict['cj2_chanzi_tongyong_move']&&C.dict['cj2_chanzi_tongyong_move'][C.mCounter]>=3"},"18.4":{"sw":["cj2_chanzi_tongyong_move",0,90],"doneExpr":"C.dict['cj2_chanzi_tongyong_move']&&C.dict['cj2_chanzi_tongyong_move'][C.mCounter]>=4"},"26.5":{"d":["s4_guochan","s4_wan_red3"],"doneExpr":"C.finishSet.has(232425)"}}};
  AP.drivers["Level-32001"] = function () {
    var T = ensurePT();
    if (!T) { return '计划引擎未就绪'; }
    return T.start(PLAN_L32001);
  };

  /* ---- L14 鸡肉咖喱（Level-32016，计划表 plans/plan32016.auto.json，53 步） ---- */
  var PLAN_L32016 = {"cls":"Level-32016","_note":"鸡肉咖喱；5=拖远>50；14=搅拌；17/18/21=7连拖；1801~1807=三段合一(洗好拖板→切→摆碟)","opts":{"maxTries":6,"settleMs":2600,"cutMax":60,"cutCadence":700,"cutTimeoutMs":120000,"stateGate":true,"stirRadius":70,"stirMs":60000},"order":[1,2,3,4,5,6,7,8,9,10,11,12,13,1100,14,15,16,1701,1702,1703,1704,1705,1706,1707,19,1801,1802,1803,1804,1805,1806,1807,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42],"steps":{"1":{"d":["coverBox1","cover1"]},"2":{"t":"faucetBox1"},"3":{"d":["boardChikenBox1","platformNode1"]},"4":{"d":["waterChikenBox1","boradNode1"]},"5":{"d":["centerCoverBox1","drop@504,1042"]},"6":{"d":["knifeBox1_1","boradNode1"]},"7":{"d":["boneBox","trashBinNode"]},"8":{"d":["knifeBox1_2","boradNode1"]},"9":{"cuts":"knifeBox1_3"},"10":{"d":["boardChikenBox5","cj1_bowlNode"]},"11":{"d":["turmericPowderBox","cj1_bowlNode"]},"12":{"d":["yogurtBox","cj1_bowlNode"]},"13":{"d":["whitePepperBox","cj1_bowlNode"]},"14":{"stir":"cj1_bowlBox"},"15":{"d":["coverBox2","cover2"]},"16":{"t":"faucetBox2"},"19":{"d":["knifeBox2_1","boradNode2"]},"22":{"t":"switchBox1"},"23":{"d":["oilBox","potNode"]},"24":{"d":["potatoBox1","potNode"]},"25":{"d":["turnerBox1","potNode"]},"26":{"d":["potPotatoBox1","cj3_dish8"]},"27":{"d":["garlicBox","potNode"]},"28":{"d":["onionBox","potNode"]},"29":{"d":["gingerBox","potNode"]},"30":{"d":["turnerBox2","potNode"]},"31":{"d":["curryBox","potNode"]},"32":{"d":["turnerBox3","potNode"]},"33":{"d":["tomatoBox","potNode"]},"34":{"d":["pepperBox","potNode"]},"35":{"d":["turnerBox4","potNode"]},"36":{"d":["chickenBox","potNode"]},"37":{"d":["turnerBox5","potNode"]},"38":{"d":["cupBox","potNode"]},"39":{"d":["potatoBox2","potNode"]},"40":{"d":["turnerBox6","potNode"]},"41":{"d":["corianderBox","potNode"]},"42":{"t":"switchBox2"},"1100":{"d":["saltBox","cj1_bowlNode"]},"1701":{"d":["vagetableBox11","platformNode2"],"doneExpr":"!C.dict['vagetableBox11'].activeInHierarchy"},"1702":{"d":["vagetableBox12","platformNode2"],"doneExpr":"!C.dict['vagetableBox12'].activeInHierarchy"},"1703":{"d":["vagetableBox13","platformNode2"],"doneExpr":"!C.dict['vagetableBox13'].activeInHierarchy"},"1704":{"d":["vagetableBox14","platformNode2"],"doneExpr":"!C.dict['vagetableBox14'].activeInHierarchy"},"1705":{"d":["vagetableBox15","platformNode2"],"doneExpr":"!C.dict['vagetableBox15'].activeInHierarchy"},"1706":{"d":["vagetableBox16","platformNode2"],"doneExpr":"!C.dict['vagetableBox16'].activeInHierarchy"},"1707":{"d":["vagetableBox17","platformNode2"],"doneExpr":"!C.dict['vagetableBox17'].activeInHierarchy && C.partInfo[17].completed"},"1801":{"acts":[{"d":["vagetableBox21","boradNode2"]},{"cuts":"knifeBox2_2"},{"d":["vagetableBox31","smallDishRoot/0+0,28"]}],"doneExpr":"C.dict['boardVagetableRoot1'].childrenCount<=6"},"1802":{"acts":[{"d":["vagetableBox22","boradNode2"]},{"cuts":"knifeBox2_2"},{"d":["vagetableBox32","smallDishRoot/1+0,28"]}],"doneExpr":"C.dict['boardVagetableRoot1'].childrenCount<=5"},"1803":{"acts":[{"d":["vagetableBox23","boradNode2"]},{"cuts":"knifeBox2_2"},{"d":["vagetableBox33","smallDishRoot/6+0,0"]}],"doneExpr":"C.dict['boardVagetableRoot1'].childrenCount<=4"},"1804":{"acts":[{"d":["vagetableBox24","boradNode2"]},{"cuts":"knifeBox2_2"},{"d":["vagetableBox34","smallDishRoot/3+0,-8"]}],"doneExpr":"C.dict['boardVagetableRoot1'].childrenCount<=3"},"1805":{"acts":[{"d":["vagetableBox25","boradNode2"]},{"cuts":"knifeBox2_2"},{"d":["vagetableBox35","smallDishRoot/4+0,-8"]}],"doneExpr":"C.dict['boardVagetableRoot1'].childrenCount<=2"},"1806":{"acts":[{"d":["vagetableBox26","boradNode2"]},{"cuts":"knifeBox2_2"},{"d":["vagetableBox36","smallDishRoot/5+0,0"]}],"doneExpr":"C.dict['boardVagetableRoot1'].childrenCount<=1"},"1807":{"acts":[{"d":["vagetableBox27","boradNode2"]},{"cuts":"knifeBox2_2"},{"d":["vagetableBox37","smallDishRoot/2+0,0"]}],"doneExpr":"C.dict['boardVagetableRoot1'].childrenCount<=0 && C.partInfo[21].completed"}}};
  AP.drivers["Level-32016"] = function () {
    var T = ensurePT();
    if (!T) { return '计划引擎未就绪'; }
    return T.start(PLAN_L32016);
  };

  /* ---- L15 法式蜗牛（Level-32065，计划表 plans/plan32065.json，52 步） ---- */
  var PLAN_L32065 = {"cls":"Level-32065","opts":{"maxTries":6,"settleMs":2600,"knifeCadence":320,"knifeMax":60,"cutMax":30,"cutCadence":1400,"cutTimeoutMs":60000},"steps":{"1":{"d":["moveBox_1","area_board"]},"2":{"acts":[{"d":["moveBox_dao","area_board"]},{"cuts":"knifeBox3"}]},"4":{"d":["vagetableBox_4","area_xiaodiezi"]},"5":{"d":["moveBox_5","area_board"]},"6":{"acts":[{"d":["moveBox_dao","area_board"]},{"cuts":"knifeBox3"}]},"8":{"d":["vagetableBox_8","area_xiaodiezi"]},"9":{"d":["moveBox_9","area_board"]},"10":{"acts":[{"d":["moveBox_dao","area_board"]},{"cuts":"knifeBox3"}]},"12":{"d":["vagetableBox_12","area_xiaodiezi"]},"13":{"d":["moveBox_13","area_board"]},"14":{"acts":[{"d":["moveBox_dao","area_board"]},{"cuts":"knifeBox3"}]},"16":{"d":["vagetableBox_16","area_xiaodiezi"]},"17":{"t":"clickBox_17"},"18":{"d":["moveBox_18","area_guangtou"]},"19":{"d":["moveBox_19","area_guo"]},"20":{"d":["moveBox_20","area_guo"]},"21":{"d":["moveBox_21","area_guo"]},"22":{"d":["moveBox_22","area_guo"]},"23":{"d":["moveBox_23","area_guo"]},"24":{"d":["moveBox_24","area_guo"]},"25":{"d":["moveBox_25","area_guo"]},"26":{"d":["moveBox_26","area_guo"]},"27":{"d":["moveBox_27","area_kongpan"]},"28":{"t":"clickBox_28"},"29":{"t":"clickBox_29"},"30":{"d":["moveBox_30","area_guo2"]},"31":{"d":["moveBox_31","area_guo2"]},"32":{"d":["moveBox_32","area_guo2"]},"33":{"d":["moveBox_33","area_guo2"]},"34":{"d":["moveBox_34","area_guo2"]},"35":{"d":["moveBox_35","area_guo2"]},"36":{"d":["moveBox_36","area_guo2"]},"37":{"d":["moveBox_37","area_guo2"]},"38":{"d":["moveBox_38","area_guo2"]},"39":{"t":"clickBox_39"},"40":{"d":["moveBox_40","area_dawan"]},"41":{"d":["moveBox_41","area_dawan"]},"42":{"d":["moveBox_42","area_dawan"]},"43":{"d":["moveBox_43","area_dawan"]},"44":{"d":["nmMoveBox1_44","area_jiazi"]},"45":{"d":["moveBox_45","area_dawan"]},"46":{"d":["nmMoveBox2_44","area_paodao"]},"47":{"d":["moveBox_47","area_dawan"]},"48":{"d":["moveBox_48","area_dawan"]},"49":{"t":"clickBox_49"},"50":{"acts":[{"d":["moveBox_wnr1","area_luorou"]},{"d":["moveBox_wnr2","area_luorou"]},{"d":["moveBox_wnr3","area_luorou"]}]},"51":{"acts":[{"d":["shaoziMoveBox_51","area_huangyoujiang"]},{"d":["hyjMoveBox_51","area_luorou"]},{"d":["shaoziMoveBox_51","area_huangyoujiang"]},{"d":["hyjMoveBox_51","area_luorou"]},{"d":["shaoziMoveBox_51","area_huangyoujiang"]},{"d":["hyjMoveBox_51","area_luorou"]}]},"52":{"d":["moveBox_52","area_kaopan"]},"53":{"sw":["slideBox_53",0,-250]},"54":{"d":["moveBox_54","area_kaoxiang"]},"55":{"t":"clickBox_55"},"56":{"sw":["slideBox_56",0,-250]}}};
  AP.drivers["Level-32065"] = function () {
    var T = ensurePT();
    if (!T) { return '计划引擎未就绪'; }
    return T.start(PLAN_L32065);
  };

  /* ---- L16 托斯卡纳三文鱼（Level-32008，计划表 plans/plan32008.auto.json，47 步） ---- */
  var PLAN_L32008 = {"cls":"Level-32008","_generated":"2026-10-06T12:16:40.974Z","opts":{"maxTries":6,"settleMs":2600,"waitTouch":3,"knifeCadence":320,"knifeMax":60,"cutMax":30,"cutCadence":700,"cutTimeoutMs":45000},"steps":{"1":{"fsh":"slideBox_1","fshFlags":["_isHasFish","_isHasShark"]},"2":{"d":["moveBox_2","area_shuicao"]},"3":{"t":"clickBox_3"},"4":{"d":["moveBox_4","area_shuicao"]},"5":{"d":["moveBox_5","area_board"]},"6":{"t":"clickBox_6"},"7":{"d":["moveBox_7","area_board"]},"8":{"d":["moveBox_8","area_board"]},"9":{"acts":[{"d":["fishMoveBox_1","area_lajitong"]},{"d":["fishMoveBox_2","area_lajitong"]},{"d":["fishMoveBox_3","area_lajitong"]},{"d":["fishMoveBox_4","area_lajitong"]},{"d":["fishMoveBox_5","area_lajitong"]},{"d":["fishMoveBox_6","area_lajitong"]},{"d":["fishMoveBox_7","area_lajitong"]},{"d":["fishMoveBox_8","area_lajitong"]}]},"10":{"d":["moveBox_10","area_board"]},"11":{"d":["moveBox_11","area_lajitong"]},"12":{"d":["moveBox_12","area_board"]},"13":{"acts":[{"sw":["slideBox_13",250,0]},{"d":["moveBox_13","area_board"]}]},"14":{"d":["moveBox_14","area_shuicao"]},"15":{"t":"clickBox_15"},"16":{"acts":[{"d":["moveBox16_17","area_shuicao"]},{"d":["moveBox16_21","area_shuicao"]},{"d":["moveBox16_25","area_shuicao"]},{"d":["moveBox16_30","area_shuicao"]}]},"17":{"d":["moveBox_17","area_board"]},"18":{"acts":[{"d":["moveBox_dao","area_board"]},{"cuts":"knifeBox3"}]},"20":{"d":["moveBox_20","area_panzi"]},"21":{"d":["moveBox_21","area_board"]},"22":{"acts":[{"d":["moveBox_dao","area_board"]},{"cuts":"knifeBox3"}]},"24":{"d":["moveBox_24","area_panzi"]},"25":{"d":["moveBox_25","area_board"]},"26":{"acts":[{"d":["moveBox_dao","area_board"]},{"cuts":"knifeBox3"}]},"28":{"d":["moveBox_28","area_panzi"]},"29":{"t":"clickBox_29"},"30":{"d":["moveBox_30","area_xiaoguo"]},"31":{"wait":true},"32":{"acts":[{"d":["moveBox_dao","area_board"]},{"cuts":"knifeBox3"}]},"34":{"acts":[{"t":"clickBox_34"},{"d":["moveBox_34","area_panzi"]}]},"35":{"t":"clickBox_35"},"36":{"d":["moveBox_36","area_guo"]},"37":{"d":["moveBox_37","area_guo"]},"38":{"d":["moveBox_38","area_dapan"]},"39":{"d":["moveBox_39","area_guo"]},"40":{"d":["moveBox_40","area_guo"]},"41":{"d":["moveBox_41","area_guo"]},"42":{"d":["moveBox_42","area_guo"]},"43":{"d":["moveBox_43","area_guo"]},"44":{"d":["moveBox_44","area_guo"]},"45":{"d":["moveBox_45","area_guo"]},"46":{"d":["moveBox_46","area_guo"]},"47":{"d":["moveBox_47","area_guo"]},"48":{"d":["moveBox_48","area_guo"]},"49":{"d":["moveBox_49","area_guo"]},"50":{"d":["moveBox_50","area_guo"]},"51":{"t":"clickBox_51"}}};
  AP.drivers["Level-32008"] = function () {
    var T = ensurePT();
    if (!T) { return '计划引擎未就绪'; }
    return T.start(PLAN_L32008);
  };

  /* ---- L18 水果蛋挞（Level-32006，计划表 plans/plan32006.auto.json，61 步） ---- */
  var PLAN_L32006 = {"cls":"Level-32006","_note":"水果蛋挞 v2 全关 2026-10-07。案卷：1刷油 2糖碗 3自动(死号借4) 4碗上台 5卷酥皮×3 6拖刀+切 7左滑推倒 8-19六片酥皮(片→盒+杖→盒配对) 20-22冰箱取模具 23-33蛋液 34-42烤箱烤制；49-54=蛋挞上盘六连(dt1..6→panzi_danta/0..5，全满时场景脚本批量写49-54) 48=喷枪×6(penqiang→s3_moju3 每次标一颗，第6次写48并切场景) 55-59=裱花袋×5(biaohuadai→panzi_danta_box 跳mid_danta) 61-66=水果六连(计数器≥6批量写) 67=椰子收尾通关。43-46/47/60=游戏不写入号，不列入。48及49+不在partInfo→全部用doneExpr finishSet.has(k)","order":["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","49","50","51","52","53","54","48","55","56","57","58","59","61","62","63","64","65","66","67"],"opts":{"maxTries":6,"settleMs":2600,"stateGate":true,"waitTouch":2,"autoWaitMs":40000,"knifeCadence":350,"knifeMax":60},"steps":{"1":{"d":["s1_shuazi","moju"]},"2":{"d":["s1_tangwan","s1_rouguiwan"]},"3":{"d":["s1_rouguiwan","liaolidian"],"doneExpr":"!!(C.partInfo[4]&&C.partInfo[4].completed)"},"4":{"d":["s1_rouguiwan","liaolidian"]},"5":{"acts":[{"sw":["cj1_juan_box",0,90]},{"sw":["cj1_juan_box",0,90]},{"sw":["cj1_juan_box",0,90]}]},"6":{"acts":[{"d":["dao_stay","boardBox"]},{"knife":"knifeBox"}]},"7":{"sw":["supi_qie",-90,0]},"8":{"acts":[{"d":["supi_fanzhuan","supi_fanzhuan_box"]},{"d":["ganmianzhang","supi_fanzhuan_box"]}]},"9":{"d":["ganmianzhang","supi_fanzhuan_box"]},"10":{"acts":[{"d":["supi_fanzhuan2","supi_fanzhuan_box"]},{"d":["ganmianzhang","supi_fanzhuan_box"]}]},"11":{"acts":[{"d":["supi_fanzhuan3","supi_fanzhuan_box"]},{"d":["ganmianzhang","supi_fanzhuan_box"]}]},"12":{"acts":[{"d":["supi_fanzhuan4","supi_fanzhuan_box"]},{"d":["ganmianzhang","supi_fanzhuan_box"]}]},"13":{"acts":[{"d":["supi_fanzhuan5","supi_fanzhuan_box"]},{"d":["ganmianzhang","supi_fanzhuan_box"]}]},"14":{"acts":[{"d":["supi_fanzhuan6","supi_fanzhuan_box"]},{"d":["ganmianzhang","supi_fanzhuan_box"]}]},"15":{"d":["ganmianzhang","supi_fanzhuan_box"]},"16":{"d":["ganmianzhang","supi_fanzhuan_box"]},"17":{"wait":true},"18":{"wait":true},"19":{"wait":true},"20":{"sw":["bingxiangBox_open",90,0]},"21":{"d":["moju","bingxiangBox_open"]},"22":{"sw":["bingxiangBox_close",-90,0]},"23":{"d":["niunai","guo"]},"24":{"d":["xiangjing","guo"]},"25":{"t":"s2_diancilu_btn"},"26":{"d":["s2_dan","s2_wan"]},"27":{"d":["s2_tangwan","s2_wan"]},"28":{"d":["s2_dianfen","s2_wan"]},"29":{"d":["shaozi","s2_wan"]},"30":{"d":["guo","s2_wan"]},"31":{"d":["shaozi","s2_wan"]},"32":{"d":["s2_wan","guo"]},"33":{"t":"s2_diancilu_btn"},"34":{"t":"kaoxiang_btn"},"35":{"d":["shuihu","s3_moju"]},"36":{"t":"kaoxiang_btn"},"37":{"sw":["kaoxiang_door_open_btn",0,-90]},"38":{"d":["s3_moju","s3_moju2"]},"39":{"sw":["kaoxiang_door_close_btn",0,90]},"40":{"t":"kaoxiang_btn"},"41":{"sw":["kaoxiang_door_open_btn",0,-90]},"42":{"d":["shoutao","s3_moju2"]},"48":{"d":["penqiang","s3_moju3"],"doneExpr":"!!(C.finishSet&&C.finishSet.has(48))","maxTries":12},"49":{"acts":[{"d":["dt1","panzi_danta/0"]},{"d":["dt2","panzi_danta/1"]},{"d":["dt3","panzi_danta/2"]},{"d":["dt4","panzi_danta/3"]},{"d":["dt5","panzi_danta/4"]},{"d":["dt6","panzi_danta/5"]}],"doneExpr":"!!(C.finishSet&&C.finishSet.has(49))","maxTries":8},"50":{"wait":true,"doneExpr":"!!(C.finishSet&&C.finishSet.has(50))"},"51":{"wait":true,"doneExpr":"!!(C.finishSet&&C.finishSet.has(51))"},"52":{"wait":true,"doneExpr":"!!(C.finishSet&&C.finishSet.has(52))"},"53":{"wait":true,"doneExpr":"!!(C.finishSet&&C.finishSet.has(53))"},"54":{"wait":true,"doneExpr":"!!(C.finishSet&&C.finishSet.has(54))"},"55":{"d":["biaohuadai","panzi_danta_box"],"doneExpr":"!!(C.finishSet&&C.finishSet.has(55))","maxTries":12},"56":{"wait":true,"doneExpr":"!!(C.finishSet&&C.finishSet.has(56))"},"57":{"wait":true,"doneExpr":"!!(C.finishSet&&C.finishSet.has(57))"},"58":{"wait":true,"doneExpr":"!!(C.finishSet&&C.finishSet.has(58))"},"59":{"wait":true,"doneExpr":"!!(C.finishSet&&C.finishSet.has(59))"},"61":{"acts":[{"d":["caomei","panzi_danta_box"]},{"d":["lanmei","panzi_danta_box"]},{"d":["tizi","panzi_danta_box"]},{"d":["lizi","panzi_danta_box"]},{"d":["zhenzhu","panzi_danta_box"]},{"d":["mangguo","panzi_danta_box"]}],"doneExpr":"!!(C.finishSet&&C.finishSet.has(61))","maxTries":8},"62":{"wait":true,"doneExpr":"!!(C.finishSet&&C.finishSet.has(62))"},"63":{"wait":true,"doneExpr":"!!(C.finishSet&&C.finishSet.has(63))"},"64":{"wait":true,"doneExpr":"!!(C.finishSet&&C.finishSet.has(64))"},"65":{"wait":true,"doneExpr":"!!(C.finishSet&&C.finishSet.has(65))"},"66":{"wait":true,"doneExpr":"!!(C.finishSet&&C.finishSet.has(66))"},"67":{"d":["yezi","panzi_danta_box"],"doneExpr":"!!(C.finishSet&&C.finishSet.has(67))","maxTries":8}}};
  AP.drivers["Level-32006"] = function () {
    var T = ensurePT();
    if (!T) { return '计划引擎未就绪'; }
    return T.start(PLAN_L32006);
  };

  /* ---- L19 可乐鸡翅（Level-32120，计划表 plans/plan32120.json，42 步） ---- */
  var PLAN_L32120 = {"cls":"Level-32120","opts":{"maxTries":5,"settleMs":2600,"waitTouch":3,"knifeCadence":320,"knifeMax":60,"cutMax":30,"cutCadence":700,"cutTimeoutMs":45000},"steps":{"1":{"d":["moveBox_1","area_che"]},"2":{"d":["moveBox_2","area_che"]},"3":{"d":["moveBox_3","area_che"]},"4":{"d":["moveBox_4","area_board"]},"5":{"d":["moveBox_dao","area_board"]},"6":{"acts":[{"armknife":true},{"cuts":"knifeBox3"},{"d":["moveBox_7","area_panzi"]}]},"7":{"d":["moveBox_7","area_panzi"]},"8":{"d":["moveBox_8","area_board"]},"9":{"acts":[{"armknife":true},{"cuts":"knifeBox3"},{"d":["moveBox_10","area_panzi"]}]},"10":{"d":["moveBox_10","area_panzi"]},"11":{"d":["moveBox_11","area_board"]},"12":{"acts":[{"armknife":true},{"cuts":"knifeBox3"}]},"13":{"d":["moveBox_13","area_guo"]},"14":{"t":"clickBox_14"},"15":{"d":["moveBox_15","area_guo"]},"16":{"d":["moveBox_16","area_guo"]},"17":{"d":["moveBox_17","area_guo"]},"18":{"d":["moveBox_17","area_guo"]},"19":{"d":["moveBox_19","area_lspz"]},"20":{"d":["moveBox_20","area_guo"]},"21":{"d":["moveBox_21","area_guo"]},"22":{"acts":[{"t":"jichiClickBox_1"},{"t":"jichiClickBox_2"},{"t":"jichiClickBox_3"},{"t":"jichiClickBox_4"},{"t":"jichiClickBox_5"},{"t":"jichiClickBox_6"}]},"23":{"d":["moveBox_23","area_guo"]},"24":{"d":["moveBox_24","area_guo"]},"25":{"d":["moveBox_25","area_guo"]},"26":{"d":["moveBox_26","area_guo"]},"27":{"acts":[{"sw":["slideBox_27",-90,0]},{"sw":["slideBox_27",-90,0]},{"sw":["slideBox_27",-90,0]},{"sw":["slideBox_27",-90,0]}]},"28":{"d":["moveBox_28","area_guo"]},"29":{"d":["moveBox_29","area_guo"]},"30":{"sw":["slideBox_30",-90,0]},"31":{"d":["moveBox_31","area_dapanzi"]},"32":{"d":["moveBox_32","area_dapanzi"]},"33":{"d":["moveBox_33","area_dapanzi"]},"34":{"d":["moveBox_34","area_dapanzi"]},"35":{"d":["moveBox_35","area_dapanzi"]},"36":{"d":["moveBox_36","area_dapanzi"]},"37":{"d":["moveBox_37","area_dapanzi"]},"38":{"d":["moveBox_38","area_dapanzi"]},"39":{"d":["moveBox_39","area_dapanzi"]},"40":{"d":["moveBox_40","area_dapanzi"]},"41":{"d":["moveBox_41","area_dapanzi"]},"42":{"d":["moveBox_42","area_dapanzi"]}}};
  AP.drivers["Level-32120"] = function () {
    var T = ensurePT();
    if (!T) { return '计划引擎未就绪'; }
    return T.start(PLAN_L32120);
  };

  /* ---- L20 马卡龙塔（Level-32069，计划表 plans/plan32069.auto.json，41 步） ---- */
  var PLAN_L32069 = {"cls":"Level-32069","_note":"马卡龙塔；genplan2 草稿 + 源码语义修正：6=左右滑、22/23=上滑、24=点按、18=按序号对 circleRootN、27=分别落 cj6_dishN；12~16 段是『三个调色碗各走一轮』：勺子1→大碗(出勺子2) → 勺子2→碗N(底料) → colorBoxN→碗N(色) → 勺子1→碗N(成酱)，三轮循环（powderCount=1/2/3）","opts":{"maxTries":6,"settleMs":2600,"cutMax":60,"cutCadence":700,"cutTimeoutMs":120000,"stateGate":true},"order":[1,2,3,4,5,6,7,8,9,10,11,1201,1301,14,1202,1203,1302,15,1204,1205,1303,16,1206,17,1801,1802,1803,1804,1805,1806,1807,1808,19,20,21,22,23,24,25,26,27],"steps":{"1":{"d":["cj1_sugarBox","blenderNode"]},"2":{"d":["almondBox","blenderNode"]},"3":{"d":["blenderLidBox","blenderNode"]},"4":{"d":["strainerBox","cj1_bowlNode"]},"5":{"d":["blenderBox","cj1_bowlNode"]},"6":{"sw":["slideBox",90,0]},"7":{"d":["cj2_bowlBox","cj2_bowlNode"]},"8":{"d":["stirrerBox1","cj2_bowlNode"]},"9":{"d":["cj2_sugarBox","cj2_bowlNode"]},"10":{"d":["cj2_saltBox","cj2_bowlNode"]},"11":{"d":["stirrerBox2","cj2_bowlNode"]},"14":{"d":["colorBox1","cj2_colorBowl1"]},"15":{"d":["colorBox2","cj2_colorBowl2"]},"16":{"d":["colorBox3","cj2_colorBowl3"]},"17":{"acts":[{"d":["pipingBagBox1","cj2_colorBowl1"]},{"d":["pipingBagBox2","cj2_colorBowl2"]},{"d":["pipingBagBox3","cj2_colorBowl3"]}]},"19":{"d":["toothPickBox","circleRootRoot#child:bubbleSk"],"jits":[[0,0],[12,0],[-12,0],[0,12],[0,-12]],"maxTries":16},"20":{"t":"switchBox"},"21":{"d":["paperBox","paperNode"]},"22":{"sw":["trayBox1",0,90]},"23":{"sw":["trayBox2",0,-90]},"24":{"acts":[{"t":"cj5_circleRootRoot/0/0"},{"t":"cj5_circleRootRoot/0/1"},{"t":"cj5_circleRootRoot/0/2"},{"t":"cj5_circleRootRoot/0/3"},{"t":"cj5_circleRootRoot/0/4"},{"t":"cj5_circleRootRoot/0/5"},{"t":"cj5_circleRootRoot/0/6"},{"t":"cj5_circleRootRoot/2/0"},{"t":"cj5_circleRootRoot/2/1"},{"t":"cj5_circleRootRoot/2/2"},{"t":"cj5_circleRootRoot/2/3"},{"t":"cj5_circleRootRoot/2/4"},{"t":"cj5_circleRootRoot/2/5"},{"t":"cj5_circleRootRoot/2/6"}]},"25":{"acts":[{"d":["cj5_colorpipingBox1","cj5_circleRootRoot/2"]},{"d":["cj5_colorpipingBox2","cj5_circleRootRoot/0"]}],"maxTries":14},"26":{"acts":[{"d":["cj5_circleRootRoot#find:circle1","cj5_circleRootRoot#free:circle1_2"]},{"sleep":1500},{"d":["cj5_circleRootRoot#find:circle1","cj5_circleRootRoot#free:circle1_2"]},{"sleep":1500},{"d":["cj5_circleRootRoot#find:circle1","cj5_circleRootRoot#free:circle1_2"]},{"sleep":1500},{"d":["cj5_circleRootRoot#find:circle2","cj5_circleRootRoot#free:circle2_2"]},{"sleep":1500},{"d":["cj5_circleRootRoot#find:circle2","cj5_circleRootRoot#free:circle2_2"]},{"sleep":1500},{"d":["cj5_circleRootRoot#find:circle2","cj5_circleRootRoot#free:circle2_2"]},{"sleep":1500},{"d":["cj5_circleRootRoot#find:circle2","cj5_circleRootRoot#free:circle2_2"]},{"sleep":1500},{"d":["cj5_circleRootRoot#find:circle2","cj5_circleRootRoot#free:circle2_2"]},{"sleep":1500},{"d":["cj5_circleRootRoot#find:circle3","cj5_circleRootRoot#free:circle3_2"]},{"sleep":1500},{"d":["cj5_circleRootRoot#find:circle3","cj5_circleRootRoot#free:circle3_2"]},{"sleep":1500},{"d":["cj5_circleRootRoot#find:circle3","cj5_circleRootRoot#free:circle3_2"]},{"sleep":1500},{"d":["cj5_circleRootRoot#find:circle3","cj5_circleRootRoot#free:circle3_2"]},{"sleep":1500},{"d":["cj5_circleRootRoot#find:circle3","cj5_circleRootRoot#free:circle3_2"]},{"sleep":1500},{"d":["cj5_circleRootRoot#find:circle3","cj5_circleRootRoot#free:circle3_2"]},{"sleep":1500}],"maxTries":12},"27":{"acts":[{"d":["cj6_dish#find:cj6_foodBox1","cj6_dish1"]},{"sleep":900},{"d":["cj6_dish#find:cj6_foodBox2","cj6_dish2"]},{"sleep":900},{"d":["cj6_dish#find:cj6_foodBox3","cj6_dish3"]},{"sleep":900},{"d":["cj6_dish#find:cj6_foodBox1","cj6_dish1"]},{"sleep":900},{"d":["cj6_dish#find:cj6_foodBox2","cj6_dish2"]},{"sleep":900},{"d":["cj6_dish#find:cj6_foodBox3","cj6_dish3"]},{"sleep":900},{"d":["cj6_dish#find:cj6_foodBox2","cj6_dish2"]},{"sleep":900},{"d":["cj6_dish#find:cj6_foodBox3","cj6_dish3"]},{"sleep":900},{"d":["cj6_dish#find:cj6_foodBox2","cj6_dish2"]},{"sleep":900},{"d":["cj6_dish#find:cj6_foodBox3","cj6_dish3"]},{"sleep":900},{"d":["cj6_dish#find:cj6_foodBox3","cj6_dish3"]},{"sleep":900}],"maxTries":8},"1201":{"d":["spoonBox1","cj2_bowlNode"],"doneExpr":"C.powderCount>=1"},"1202":{"d":["spoonBox1","cj2_colorBowl1"],"doneExpr":"C.dict['cj2_colorBowl1'].getChildByName('colorBowlSauce3').active"},"1203":{"d":["spoonBox1","cj2_bowlNode"],"doneExpr":"C.powderCount>=2"},"1204":{"d":["spoonBox1","cj2_colorBowl2"],"doneExpr":"C.dict['cj2_colorBowl2'].getChildByName('colorBowlSauce3').active"},"1205":{"d":["spoonBox1","cj2_bowlNode"],"doneExpr":"C.powderCount>=3"},"1206":{"d":["spoonBox1","cj2_colorBowl3"],"doneExpr":"C.dict['cj2_colorBowl3'].getChildByName('colorBowlSauce3').active"},"1301":{"d":["spoonBox2","cj2_colorBowl1"],"doneExpr":"C.dict['cj2_colorBowl1'].getChildByName('colorBowlSauce1').active||C.dict['cj2_colorBowl1'].getChildByName('colorBowlSauce3').active"},"1302":{"d":["spoonBox2","cj2_colorBowl2"],"doneExpr":"C.dict['cj2_colorBowl2'].getChildByName('colorBowlSauce1').active||C.dict['cj2_colorBowl2'].getChildByName('colorBowlSauce3').active"},"1303":{"d":["spoonBox2","cj2_colorBowl3"],"doneExpr":"C.dict['cj2_colorBowl3'].getChildByName('colorBowlSauce1').active||C.dict['cj2_colorBowl3'].getChildByName('colorBowlSauce3').active"},"1801":{"d":["cj3_colorpipingBox1","circleRootRoot/0"],"maxTries":12,"doneExpr":"C.dict['circleRootRoot'].children[0].completed"},"1802":{"d":["cj3_colorpipingBox1","circleRootRoot/1"],"maxTries":12,"doneExpr":"C.dict['circleRootRoot'].children[1].completed"},"1803":{"d":["cj3_colorpipingBox2","circleRootRoot/2"],"maxTries":12,"doneExpr":"C.dict['circleRootRoot'].children[2].completed"},"1804":{"d":["cj3_colorpipingBox2","circleRootRoot/3"],"maxTries":12,"doneExpr":"C.dict['circleRootRoot'].children[3].completed"},"1805":{"d":["cj3_colorpipingBox2","circleRootRoot/4"],"maxTries":12,"doneExpr":"C.dict['circleRootRoot'].children[4].completed"},"1806":{"d":["cj3_colorpipingBox2","circleRootRoot/5"],"maxTries":12,"doneExpr":"C.dict['circleRootRoot'].children[5].completed"},"1807":{"d":["cj3_colorpipingBox3","circleRootRoot/6"],"maxTries":12,"doneExpr":"C.dict['circleRootRoot'].children[6].completed"},"1808":{"d":["cj3_colorpipingBox3","circleRootRoot/7"],"maxTries":12,"doneExpr":"C.dict['circleRootRoot'].children[7].completed"}}};
  AP.drivers["Level-32069"] = function () {
    var T = ensurePT();
    if (!T) { return '计划引擎未就绪'; }
    return T.start(PLAN_L32069);
  };

  /* ====== L17 惠灵顿牛排（Level-32068，源文件 expr_lv68play.js，两段式）====== */
  function lv68run() {
  var H = window.__HLD__;
    var Q = window.__L68Q__ = window.__L68Q__ || [];

    // ---------- ① 原型 hook（幂等） ----------
    function install() {
      var cls = null;
      try { cls = cc.js.getClassByName('Level-32068'); } catch (e) { }
      if (!cls || !cls.prototype) return 'no class Level-32068';
      if (cls.__w68) return 'already';
      var proto = cls.prototype;
      var origDrag = proto['bindDragToCorrentPlaceByDistanceEvent'];
      var origScroll = proto['bindScrollEvent'];
      var origClick = proto['bindClickEvent'];
      if (typeof origDrag !== 'function' || typeof origScroll !== 'function' || typeof origClick !== 'function') return 'methods missing';
      proto['bindDragToCorrentPlaceByDistanceEvent'] = function (node, area, p3, thr, cb, ms) {
        var rec = { kind: 'drag', node: node, area: area, p3: p3, thr: thr, t: Date.now(), id: Q.length + 1, attempts: 0, cbFired: false, staleAt: 0 };
        if (typeof cb === 'function') { rec.cb = function () { rec.cbFired = true; return cb.apply(this, arguments); }; Q.push(rec); }
        else { rec.noCb = true; }
        return origDrag.call(this, node, area, p3, thr, rec.cb, ms);
      };
      proto['bindScrollEvent'] = function (node, dir, cb) {
        var rec = { kind: 'scroll', node: node, dir: dir, t: Date.now(), id: Q.length + 1, attempts: 0, cbFired: false, staleAt: 0 };
        if (typeof cb === 'function') { rec.cb = function () { rec.cbFired = true; return cb.apply(this, arguments); }; Q.push(rec); }
        else { rec.noCb = true; }
        return origScroll.call(this, node, dir, rec.cb);
      };
      proto['bindClickEvent'] = function (node, cb) {
        var rec = { kind: 'click', node: node, t: Date.now(), id: Q.length + 1, attempts: 0, cbFired: false, staleAt: 0 };
        if (typeof cb === 'function') { rec.cb = function () { rec.cbFired = true; return cb.apply(this, arguments); }; Q.push(rec); }
        else { rec.noCb = true; }
        return origClick.call(this, node, rec.cb);
      };
      cls.__w68 = true;
      return 'patched';
    }
    var installRes = install();

    var C = null;
    H.findAll('Level').forEach(function (c) {
      try { if (H.clsName(c) === 'Level-32068' && c.node && c.node.activeInHierarchy) C = c; } catch (e) { }
    });
    if (!C) return JSON.stringify({ phase: 'installed', install: installRes, queue: Q.length, hint: 'enter level then run again' });
    window.__C68__ = C;
    if (window.__L68P && window.__L68P.timer) { clearInterval(window.__L68P.timer); window.__L68P.timer = null; }
    var P = window.__L68P = { log: [], t0: Date.now(), done: false, won: false, busy: false, acts: 0, seq: 0 };

    function L() {
      var a = [].slice.call(arguments);
      P.log.push(((Date.now() - P.t0) / 1000).toFixed(1) + 's ' + a.join(' '));
      if (P.log.length > 900) P.log.splice(0, 450);
    }
    function nm(n) { try { return n ? n.name : '?'; } catch (e) { return '?'; } }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function worldOf(n) { return n.convertToWorldSpaceAR(cc.v2(0, 0)); }
    function hasT(n, t) { try { return n.hasEventListener(t); } catch (e) { return false; } }

    // ---------- 合成触摸 ----------
    var TOUCH_ID = 0x6832; var touch = cc.v2(0, 0), startPt = cc.v2(0, 0), lastDelta = cc.v2(0, 0);
    function mkEv(node) {
      return {
        target: node, getID: function () { return TOUCH_ID; },
        getLocation: function () { return cc.v2(touch.x, touch.y); },
        getDelta: function () { return cc.v2(lastDelta.x, lastDelta.y); },
        stopPropagation: function () { }, stopPropagationImmediate: function () { },
        touch: { _point: cc.v2(touch.x, touch.y), _startPoint: cc.v2(startPt.x, startPt.y) }
      };
    }
    var RATIO = [0.06, 0.10, 0.14, 0.18, 0.20, 0.20, 0.18, 0.16, 0.14, 0.12, 0.12, 0.14, 0.18, 0.25, 0.35, 1];
    var JIT = [[0, 0], [0, 40], [0, -40], [40, 0], [-40, 0], [0, 70], [0, -70], [70, 0], [-70, 0]];

    // 通关检测：playRight（结算）
    try {
      var opr = C.playRight;
      if (typeof opr === 'function' && !opr.__w68p) {
        var pr = function () { P.won = true; L('playRight!'); return opr.apply(this, arguments); };
        pr.__w68p = true; C.playRight = pr;
      }
    } catch (e) { }

    // ---------- 手势执行 ----------
    async function driveDrag(rec) {
      var n = rec.node, area = rec.area;
      if (!n || !area) return 'no node/area';
      if (n['disableDragCheck']) return 'gated';
      var w = worldOf(n); touch.x = w.x; touch.y = w.y; startPt = cc.v2(w.x, w.y); lastDelta = cc.v2(0, 0);
      try {
        n.emit('touchstart', mkEv(n));
        await sleep(80 + Math.random() * 40);
        var jit = JIT[rec.attempts % JIT.length];
        var tgt;
        if (rec.p3 && rec.p3.x !== undefined) tgt = cc.v2(rec.p3.x, rec.p3.y);
        else tgt = cc.v2(-16, 0);
        tgt.x += jit[0]; tgt.y += jit[1];
        for (var i = 0; i < 22; i++) {
          var cur = n.getPosition();
          var rem = cc.v2(tgt.x - cur.x, tgt.y - cur.y);
          if (rem.mag() < 2.5) break;
          var r = RATIO[Math.min(i, 15)];
          var d = cc.v2(rem.x * r, rem.y * r);
          lastDelta = d; touch.x += d.x; touch.y += d.y;
          n.emit('touchmove', mkEv(n));
          await sleep(36 + Math.random() * 8);
          if (rec.cbFired) break;
        }
      } finally {
        lastDelta = cc.v2(0, 0);
        try { n.emit('touchend', mkEv(n)); } catch (e) { }
      }
      return 'drag->' + Math.round(tgt.x) + ',' + Math.round(tgt.y);
    }
    async function driveScroll(rec) {
      var n = rec.node; if (!n) return 'no node';
      var dir = rec.dir || cc.v2(0, -60);
      var w = worldOf(n); touch.x = w.x; touch.y = w.y; startPt = cc.v2(w.x, w.y); lastDelta = cc.v2(0, 0);
      n.emit('touchstart', mkEv(n));
      await sleep(60);
      var m = Math.max(Math.abs(dir.x), Math.abs(dir.y)) * 1.8 + 50;
      var sx = dir.x ? (dir.x > 0 ? 1 : -1) : 0, sy = dir.y ? (dir.y > 0 ? 1 : -1) : 0;
      for (var i = 0; i < 6; i++) {
        var d = cc.v2(sx * m / 6, sy * m / 6);
        d.x += (Math.random() - 0.5) * 6; d.y += (Math.random() - 0.5) * 6;
        lastDelta = d; touch.x += d.x; touch.y += d.y;
        n.emit('touchmove', mkEv(n));
        await sleep(30 + Math.random() * 14);
        if (rec.cbFired) break;
      }
      lastDelta = cc.v2(0, 0);
      n.emit('touchend', mkEv(n));
      return 'scroll ' + (dir.x || 0) + ',' + (dir.y || 0);
    }
    async function driveClick(rec) {
      var n = rec.node; if (!n) return 'no node';
      var w = worldOf(n); touch.x = w.x; touch.y = w.y; startPt = cc.v2(w.x, w.y); lastDelta = cc.v2(0, 0);
      n.emit('touchstart', mkEv(n));
      await sleep(70 + Math.random() * 60);
      lastDelta = cc.v2(0, 0);
      n.emit('touchend', mkEv(n));
      return 'click';
    }

    function armed(rec) {
      var n = rec.node;
      if (!n || !n.isValid || !n.activeInHierarchy) return false;
      if (rec.kind === 'scroll') return hasT(n, 'touchmove');
      return hasT(n, 'touchend') || hasT(n, 'touchstart');
    }

    var seenQ = 0;
    function drain() {
      while (seenQ < Q.length) {
        var r = Q[seenQ++];
        L('arm#' + r.id + ' ' + r.kind + ' ' + nm(r.node) +
          (r.kind === 'drag' ? (' thr=' + r.thr + ' p3=' + (r.p3 ? (r.p3.x + ',' + r.p3.y) : 'null')) : '') +
          (r.kind === 'scroll' && r.dir ? (' dir=' + r.dir.x + ',' + r.dir.y) : '') + (r.noCb ? ' noCb' : ''));
      }
    }

    async function tick() {
      if (P.busy || P.done) return;
      drain();
      var now = Date.now();
      // 清理失效节点记录（重进关后旧记录直接失效）
      for (var qi = 0; qi < Q.length; qi++) { var qr = Q[qi]; if (qr.node && !qr.node.isValid) qr.cbFired = true; }
      var cands = Q.filter(function (r) {
        return !r.cbFired && !r.noCb && typeof r.cb === 'function' && now > r.staleAt && armed(r) &&
          !(r.kind === 'drag' && r.node && r.node['disableDragCheck']);
      });
      if (!cands.length) {
        try { if (P.won || (C.dict['sceneFinish'] && C.dict['sceneFinish'].activeInHierarchy)) { P.done = true; L('WIN! acts=' + P.acts); if (P.timer) { clearInterval(P.timer); P.timer = null; } } } catch (e) { }
        return;
      }
      cands.sort(function (a, b) { return a.t - b.t; });
      var r = cands[0];
      P.busy = true;
      var res = '';
      try { res = await (r.kind === 'drag' ? driveDrag(r) : (r.kind === 'scroll' ? driveScroll(r) : driveClick(r))); }
      catch (e) { res = 'ERR ' + e.message; }
      r.attempts++; P.acts++;
      await sleep(1000 + Math.random() * 1400);
      var still = r.cbFired ? false : armed(r);
      L('do#' + r.id + ' ' + r.kind + ' ' + nm(r.node) + ' -> ' + res + ' fired=' + r.cbFired + ' rest=' + still + ' att=' + r.attempts);
      if (!r.cbFired && still && r.attempts >= 3) { r.staleAt = Date.now() + (r.kind === 'drag' ? 25000 : 8000); r.attempts = 0; L('stale#' + r.id + ' ' + nm(r.node) + ' 冷却'); }
      P.busy = false;
    }
    P.timer = setInterval(function () { try { tick(); } catch (e) { L('tickERR ' + e.message); } }, 500);
    return JSON.stringify({ ok: true, phase: 'attached', install: installRes, queue: Q.length, log: P.log.slice(-6) });
  }
  AP.drivers["Level-32068"] = function () {
    try { return String(lv68run()).slice(0, 160); } catch (e) { return '32068 装载出错：' + e.message; }
  };
  // 进关前预装原型补丁：每 250ms 试一次，类一加载进内存就补上（起手手势必须在进关瞬间已挂好）
  AP.prepatch = function () {
    try {
      var cls = null;
      try { cls = W.cc && cc.js && cc.js.getClassByName('Level-32068'); } catch (e) { }
      if (cls && cls.__w68) { return true; }
      lv68run();
      try { cls = W.cc && cc.js && cc.js.getClassByName('Level-32068'); } catch (e) { }
      return !!(cls && cls.__w68);
    } catch (e) { return false; }
  };

  AP.boot();
})();

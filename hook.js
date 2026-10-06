/* ============================================================
   补丁壳 · 通用模板（页面 hook 版）
   ------------------------------------------------------------
   用途：把官方 CDN 上的游戏脚本「现拉现改」，让它在自己域名下也能跑。
   配合 assets/index.html 使用：index.html 先引 hook.js，再引官方启动脚本。

   换一个游戏要改的只有下面 CFG 和后三个 NEEDLE 常量，
   怎么求这三个锚点见 references/hosting.md 的「换游戏怎么套」。

   这个文件是 2026-10-06《快乐小日子》上线版（v2.1）的实跑版本，
   已逐字节比对验证过，改完记得把 CFG.cacheName 的版本号 +1。
   ============================================================ */

var CFG = {
  // 官方 CDN 目录（index.html 里的 <base> 也必须是它）
  cdn: 'https://static.zuiqiangyingyu.net/wb_webview/happylittledays/h5/',
  // 改任何规则都要 +1，否则用户浏览器里那份旧补丁会被一直复用
  cacheName: 'hld-patch-v3',
  // 三类脚本：引擎 / 启动脚本 / 分包
  engineRe: /\/cocos2d-js-min[a-z0-9.]*\.js(\?|#|$)/,
  bootRe: /\/s\.[0-9a-f]+\.js(\?|#|$)/,
  bundleRe: /\/assets\/[^\/]+\/index\.[0-9a-f]+\.js(\?|#|$)/,
  // 引擎里要写死的官方域名（config 拿它当解密密钥）
  hostKey: 'static.zuiqiangyingyu.net'
};

(function () {
  var CDN_PREFIX = CFG.cdn;
  var CACHE_NAME = CFG.cacheName;
  var engineRe = CFG.engineRe, bootRe = CFG.bootRe, bundleRe = CFG.bundleRe;
  var mem = Object.create(null);

  function isTarget(abs) {
    return abs.indexOf(CDN_PREFIX) === 0 && (engineRe.test(abs) || bootRe.test(abs) || bundleRe.test(abs));
  }

  // ---- 字节工具 ----
  function bytes(str) {
    var u = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 0xff;
    return u;
  }
  function startsWith(u8, i, needle) {
    if (i + needle.length > u8.length) return false;
    for (var k = 0; k < needle.length; k++) if (u8[i + k] !== needle[k]) return false;
    return true;
  }
  function isHex(b) { return (b >= 48 && b <= 57) || (b >= 97 && b <= 102); }

  var ONE = new Uint8Array([49]); // '1'

  // 锁 3 锚点：反调试守卫。必须带上下文！
  // 裸串 ['\x69\x6e\x69\x74']() 在本例里有 5 处，只有 1 处是守卫，
  // 按裸串删会误伤真代码 → SyntaxError: Unexpected identifier。
  // 下面这串是「'threshold':0x64}) + 守卫调用」，换游戏按 references/hosting.md 重新求。
  var NEEDLE_GUARD = bytes("\\x74\\x68\\x72\\x65\\x73\\x68\\x6f\\x6c\\x64':0x64})['\\x69\\x6e\\x69\\x74']();");
  var GUARD_REPL = bytes("\\x74\\x68\\x72\\x65\\x73\\x68\\x6f\\x6c\\x64':0x64});");

  // 锁 2 锚点：引擎解密钥匙
  var NEEDLE_HOSTKEY = bytes(',location.hostname)');
  var HOSTKEY_REPL = bytes(",'" + CFG.hostKey + "')");

  // ---- 就地改写 ----
  function patchBytes(u8, kind) { // kind: 'engine' | 'boot' | 'bundle'
    var n = u8.length, i = 0, last = 0, found = 0, parts = null;

    function begin() { if (!parts) parts = []; }
    function cut(end) { begin(); parts.push(u8.subarray(last, end)); }

    while (i < n) {
      // 锁 2：引擎解密钥匙
      if (kind === 'engine' && startsWith(u8, i, NEEDLE_HOSTKEY)) {
        cut(i);
        parts.push(HOSTKEY_REPL);
        last = i + NEEDLE_HOSTKEY.length;
        found++;
        i = last;
        continue;
      }
      // 锁 3：反调试守卫（带上下文锚点）
      if (kind === 'boot' && startsWith(u8, i, NEEDLE_GUARD)) {
        cut(i);
        parts.push(GUARD_REPL);
        last = i + NEEDLE_GUARD.length;
        found++;
        i = last;
        continue;
      }
      // 锁 1：域名锁  if(!_0xXXXX){var _0xYYYY=new RegExp('  ->  if(!1){
      if (u8[i] === 105 && u8[i + 1] === 102 && u8[i + 2] === 40 && u8[i + 3] === 33 &&
          u8[i + 4] === 95 && u8[i + 5] === 48 && u8[i + 6] === 120) {
        var j = i + 7;
        while (j < n && isHex(u8[j])) j++;
        if (j > i + 7 && u8[j] === 41 && u8[j + 1] === 123 &&
            u8[j + 2] === 118 && u8[j + 3] === 97 && u8[j + 4] === 114 && u8[j + 5] === 32 &&
            u8[j + 6] === 95 && u8[j + 7] === 48 && u8[j + 8] === 120) {
          var k = j + 9;
          while (k < n && isHex(u8[k])) k++;
          if (k > j + 9 &&
              u8[k] === 61 && u8[k + 1] === 110 && u8[k + 2] === 101 && u8[k + 3] === 119 && u8[k + 4] === 32 &&
              u8[k + 5] === 82 && u8[k + 6] === 101 && u8[k + 7] === 103 && u8[k + 8] === 69 &&
              u8[k + 9] === 120 && u8[k + 10] === 112 && u8[k + 11] === 40 && u8[k + 12] === 39) {
            cut(i + 4);   // 保留 "if(!"
            parts.push(ONE);
            last = j;     // 从 ")" 继续
            found++;
            i = k + 13;
            continue;
          }
        }
      }
      i++;
    }
    if (!found) return null;
    parts.push(u8.subarray(last));
    return { blob: new Blob(parts, { type: 'application/javascript' }), found: found };
  }

  function kindOf(url) {
    if (engineRe.test(url)) return 'engine';
    if (bootRe.test(url)) return 'boot';
    return 'bundle';
  }

  // 只报警不改行为的语法自检：改坏了能在控制台一眼看到
  function sanityCheck(ab, url) {
    try {
      new Function(new TextDecoder('utf-8').decode(ab));
    } catch (e) {
      console.warn('[hld] warning: patched script failed the syntax check (still shipped): ' + url + ' :: ' + (e && e.message));
    }
  }

  function fetchAndPatch(url) {
    var kind = kindOf(url);
    return fetch(url, { credentials: 'omit' }).then(function (res) {
      if (!res.ok) throw new Error('http ' + res.status);
      return res.arrayBuffer();
    }).then(function (ab) {
      var r = patchBytes(new Uint8Array(ab), kind);
      if (!r) {
        console.warn('[hld] no patch point found, shipping as-is: ' + url);
        return null;
      }
      console.log('[hld] patched ' + r.found + ' site(s) (' + kind + ') - ' +
        Math.round(ab.byteLength / 1024) + 'KB - ' + url.replace(CDN_PREFIX, ''));
      return r.blob.arrayBuffer().then(function (patched) {
        sanityCheck(patched, url);
        return new Blob([patched], { type: 'application/javascript' });
      });
    });
  }

  function cacheGet(url) {
    if (!window.caches) return Promise.resolve(null);
    return caches.open(CACHE_NAME).then(function (c) { return c.match(url); }).then(function (r) {
      return r ? r.blob() : null;
    }).catch(function () { return null; });
  }

  function cachePut(url, blob) {
    if (!window.caches) return Promise.resolve();
    return caches.open(CACHE_NAME).then(function (c) {
      return c.put(url, new Response(blob, { headers: { 'Content-Type': 'application/javascript' } }));
    }).catch(function () {});
  }

  function resolvePatched(url) {
    if (mem[url]) return Promise.resolve(mem[url]);
    return cacheGet(url).then(function (blob) {
      if (blob) { mem[url] = URL.createObjectURL(blob); return mem[url]; }
      return fetchAndPatch(url).then(function (b) {
        if (!b) return null;
        mem[url] = URL.createObjectURL(b);
        cachePut(url, b);
        return mem[url];
      });
    });
  }

  // ---- 劫持 <script src>，命中就换成补丁后的 blob ----
  var proto = window.HTMLScriptElement && window.HTMLScriptElement.prototype;
  if (proto) {
    var d = Object.getOwnPropertyDescriptor(proto, 'src');
    var rawSetSrc = (d && d.set) ? d.set : function (v) { proto.setAttribute.call(this, 'src', v); };
    var rawGetSrc = (d && d.get) ? d.get : function () { return this.getAttribute('src') || ''; };
    var rawSetAttr = proto.setAttribute;

    function rewrite(el, abs) {
      el.__hldPending = abs;
      resolvePatched(abs).then(function (u) {
        if (el.__hldPending !== abs) return;
        rawSetSrc.call(el, u || abs);
      }, function (e) {
        if (el.__hldPending !== abs) return;
        console.warn('[hld] fetch failed, falling back to the original url: ' + abs, e);
        rawSetSrc.call(el, abs);
      });
    }

    Object.defineProperty(proto, 'src', {
      configurable: true,
      enumerable: d ? d.enumerable : true,
      get: function () { return rawGetSrc.call(this); },
      set: function (v) {
        var abs = null;
        try { abs = new URL(String(v), document.baseURI).href; } catch (e) {}
        if (abs && isTarget(abs)) { rewrite(this, abs); return; }
        rawSetSrc.call(this, v);
      }
    });

    proto.setAttribute = function (name, value) {
      if (String(name).toLowerCase() === 'src') { this.src = value; return; }
      return rawSetAttr.call(this, name, value);
    };
  }

  window.__HLD_HOOK__ = { version: '2.1', isTarget: function (u) { return isTarget(u); } };
})();

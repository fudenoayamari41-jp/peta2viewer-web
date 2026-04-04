// api/proxy.js
// Vercel サーバーレス関数：peta2掲示板へのCORSプロキシ
// - 認証機能：Vercel KVによる合言葉チェックを追加
// - Shift-JIS対応（バッファをそのまま転送）
// - iframeでの表示用に <base> タグをインジェクション

import { createClient } from '@vercel/kv';

const kv = createClient({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const KEY_SET_NAME = 'peta2:authorized_keys';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ error: 'Missing required query parameter: url' });
    }

    // ----------------------------------------------------
    // 合言葉（アクセスキー）の検証
    // ----------------------------------------------------
    const userKey = req.headers['x-access-key'] || req.query.access_key;
    
    try {
        if (!userKey) {
            throw new Error('Missing Access Key');
        }
        
        // Vercel KV のセット (authorized_keys) に含まれているか照会
        const isValid = await kv.sismember(KEY_SET_NAME, userKey);
        
        if (!isValid) {
            return res.status(401).json({ 
                error: 'Unauthorized', 
                message: '無効な合言葉です。再度入力してください。' 
            });
        }
    } catch (e) {
        return res.status(401).json({ 
            error: 'Unauthorized', 
            message: '合言葉（アクセスキー）が必要です。' 
        });
    }

    // ----------------------------------------------------
    // URLの簡易バリデーション
    // ----------------------------------------------------
    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('Invalid protocol');
        }
    } catch {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    const upstreamHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Referer': parsedUrl.origin + '/',
    };

    // Peta2 入室鍵（スレッドパスワード）およびクライアントからのCookieを追加
    const peta2ItemKey = req.headers['x-peta2-item-key'];
    const clientCookies = req.headers['x-peta2-cookies'] || '';
    
    let combinedCookies = [];
    if (clientCookies) combinedCookies.push(clientCookies);
    
    if (peta2ItemKey) {
        let threadId = parsedUrl.searchParams.get('t') || '';
        combinedCookies.push(`thread_key=${peta2ItemKey}`);
        if (threadId) {
            combinedCookies.push(`thread_key_${threadId}=${peta2ItemKey}`);
        }
    }
    
    if (combinedCookies.length > 0) {
        upstreamHeaders['Cookie'] = combinedCookies.join('; ');
    }

    try {
        let upstream = await fetch(targetUrl, {
            headers: upstreamHeaders,
        });

        let gateCookiesForClient = '';

        // ---- 門限ページ（enter.php / agreement.php）のサーバーサイド自動突破 ----
        if (upstream.url.includes('enter.php') || upstream.url.includes('agreement.php')) {
            console.log('[proxy-api] Gate page detected at:', upstream.url);

            try {
                const gateBuffer = await upstream.arrayBuffer();
                const gateHtml = new TextDecoder('shift-jis').decode(Buffer.from(gateBuffer));

                // ゲートレスポンスのCookieを収集
                let gateCookiePairs = [];
                const gateSetCookie = upstream.headers.get('set-cookie');
                if (gateSetCookie) {
                    gateSetCookie.split(/,(?=\s*[a-zA-Z0-9_]+=)/).forEach(c => {
                        gateCookiePairs.push(c.split(';')[0].trim());
                    });
                }

                // フォームを解析して自動送信
                const formMatch = gateHtml.match(/<form([^>]*)>([\s\S]*?)<\/form>/i);
                if (formMatch) {
                    const formAttrs = formMatch[1];
                    const formContent = formMatch[2];

                    const methodMatch = formAttrs.match(/method\s*=\s*["']?(\w+)["']?/i);
                    const method = (methodMatch ? methodMatch[1] : 'GET').toUpperCase();

                    const actionMatch = formAttrs.match(/action\s*=\s*["']([^"']*)["']/i);
                    let formAction = upstream.url;
                    if (actionMatch && actionMatch[1]) {
                        formAction = new URL(actionMatch[1], upstream.url).href;
                    }

                    // input要素を収集
                    const inputs = {};
                    const inputRegex = /<input[^>]+>/gi;
                    let inputEl;
                    while ((inputEl = inputRegex.exec(formContent)) !== null) {
                        const nameM = inputEl[0].match(/name\s*=\s*["']([^"']*)["']/i);
                        const valM = inputEl[0].match(/value\s*=\s*["']([^"']*)["']/i);
                        if (nameM) inputs[nameM[1]] = valM ? valM[1] : '';
                    }

                    console.log('[proxy-api] Auto-submitting gate form:', { method, action: formAction, fields: Object.keys(inputs) });

                    const submitHeaders = { ...upstreamHeaders };
                    const submitCookieStr = [...combinedCookies, ...gateCookiePairs].filter(Boolean).join('; ');
                    if (submitCookieStr) submitHeaders['Cookie'] = submitCookieStr;

                    let submitResponse;
                    if (method === 'POST') {
                        submitHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
                        submitResponse = await fetch(formAction, {
                            method: 'POST',
                            headers: submitHeaders,
                            body: new URLSearchParams(inputs).toString(),
                            redirect: 'manual',
                        });
                    } else {
                        const getUrl = new URL(formAction);
                        Object.entries(inputs).forEach(([k, v]) => getUrl.searchParams.set(k, v));
                        submitResponse = await fetch(getUrl.href, {
                            headers: submitHeaders,
                            redirect: 'manual',
                        });
                    }

                    // フォーム送信レスポンスからCookieを収集
                    const submitSetCookie = submitResponse.headers.get('set-cookie');
                    if (submitSetCookie) {
                        submitSetCookie.split(/,(?=\s*[a-zA-Z0-9_]+=)/).forEach(c => {
                            gateCookiePairs.push(c.split(';')[0].trim());
                        });
                    }
                }

                // 収集したCookieで元のURLを再取得
                if (gateCookiePairs.length > 0) {
                    const retryHeaders = { ...upstreamHeaders };
                    const allCookies = [...combinedCookies, ...gateCookiePairs].filter(Boolean).join('; ');
                    retryHeaders['Cookie'] = allCookies;

                    console.log('[proxy-api] Re-fetching original URL with gate cookies...');
                    const retry = await fetch(targetUrl, { headers: retryHeaders });

                    if (!retry.url.includes('enter.php') && !retry.url.includes('agreement.php')) {
                        console.log('[proxy-api] Gate auto-entry succeeded!');
                        upstream = retry;
                        gateCookiesForClient = gateCookiePairs.map(c => c + '; Path=/').join(', ');
                    } else {
                        console.log('[proxy-api] Gate auto-entry failed, showing gate page');
                        upstream = retry;
                    }
                }
            } catch (gateErr) {
                console.error('[proxy-api] Gate auto-entry error:', gateErr);
                try { upstream = await fetch(targetUrl, { headers: upstreamHeaders }); } catch(e2) {}
            }
        }

        // デバッグ用: リダイレクトが発生しているかログ出力
        if (upstream.url !== targetUrl) {
            console.log(`[proxy-api] Redirect detected: ${targetUrl} -> ${upstream.url}`);
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('x-res-url', upstream.url);

        // 上流 + 門限突破で得たCookieをクライアントへ転送
        const upstreamSetCookie = upstream.headers.get('set-cookie');
        const mergedSetCookies = [upstreamSetCookie, gateCookiesForClient].filter(Boolean).join(', ');
        if (mergedSetCookies) {
            const cookies = mergedSetCookies.split(/,(?=\s*[a-zA-Z0-9_]+=)/);
            cookies.forEach(cookie => {
                const cleaned = cookie.replace(/Domain=[^;]+;?\s*/i, '').replace(/Path=[^;]+;?\s*/i, 'Path=/;');
                res.appendHeader('Set-Cookie', cleaned);
            });
            res.setHeader('x-set-cookie', mergedSetCookies);
        }

        res.setHeader('Access-Control-Expose-Headers', 'x-res-url, x-set-cookie');

        const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);

        if (contentType.includes('text/html')) {
            const bodyBuffer = await upstream.arrayBuffer();
            const bodyBytes = Buffer.from(bodyBuffer);
            const decoder = new TextDecoder('shift-jis');
            let htmlText = decoder.decode(bodyBytes);

            const baseTag = `<base href="${parsedUrl.origin}${parsedUrl.pathname.replace(/[^/]*$/, '')}">`;

            if (htmlText.includes('<head>')) {
                htmlText = htmlText.replace('<head>', `<head>\n    ${baseTag}`);
            } else if (htmlText.includes('<HEAD>')) {
                htmlText = htmlText.replace('<HEAD>', `<HEAD>\n    ${baseTag}`);
            } else {
                htmlText = baseTag + '\n' + htmlText;
            }

            // Cookie同期用スクリプトの注入
            if (mergedSetCookies) {
                const scriptInjection = `
<script id="peta2-cookie-sync" data-cookie="${mergedSetCookies.replace(/"/g, '&quot;')}">
  (function() {
    try {
      const cookie = document.getElementById('peta2-cookie-sync').dataset.cookie;
      if (cookie && window.parent !== window) {
        window.parent.postMessage({ type: 'peta2_cookie_update', cookie: cookie }, '*');
      }
    } catch(e) {}
  })();
</script>`;
                if (htmlText.includes('</head>')) {
                    htmlText = htmlText.replace('</head>', `${scriptInjection}\n</head>`);
                } else if (htmlText.includes('</HEAD>')) {
                    htmlText = htmlText.replace('</HEAD>', `${scriptInjection}\n</HEAD>`);
                } else {
                    htmlText += scriptInjection;
                }
            }

            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.status(upstream.status).send(htmlText);
        }

        const bodyBuffer = await upstream.arrayBuffer();
        return res.status(upstream.status).send(Buffer.from(bodyBuffer));

    } catch (error) {
        console.error('[proxy-api] Error:', error);
        return res.status(502).json({
            error: 'Bad Gateway',
            message: error.message,
        });
    }
}

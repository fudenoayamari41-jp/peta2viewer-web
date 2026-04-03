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
    const userKey = req.headers['x-access-key'];
    
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

    // Peta2 入室鍵（スレッドパスワード）をCookieとして追加
    const peta2ItemKey = req.headers['x-peta2-item-key'];
    if (peta2ItemKey) {
        let threadId = parsedUrl.searchParams.get('t') || '';
        const newCookies = [`thread_key=${peta2ItemKey}`];
        if (threadId) {
            newCookies.push(`thread_key_${threadId}=${peta2ItemKey}`);
        }
        upstreamHeaders['Cookie'] = newCookies.join('; ');
    }

    try {
        const upstream = await fetch(targetUrl, {
            headers: upstreamHeaders,
        });

        // デバッグ用: リダイレクトが発生しているかログ出力
        if (upstream.url !== targetUrl) {
            console.log(`[proxy-api] Redirect detected: ${targetUrl} -> ${upstream.url}`);
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        // クライアント側に最終的な到達URLを知らせる
        res.setHeader('x-res-url', upstream.url);
        // クライアント側でJSから読み取れるように公開する
        res.setHeader('Access-Control-Expose-Headers', 'x-res-url');

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

            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            // 文字列として送信する場合、Vercel(Express)は自動的にUTF-8としてエンコードします
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

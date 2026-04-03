// api/proxy.js
// Vercel サーバーレス関数：peta2掲示板へのCORSプロキシ
// - Shift-JIS対応（バッファをそのまま転送）
// - iframeでの表示用に <base> タグをインジェクション

export default async function handler(req, res) {
    // 許可するHTTPメソッド
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ error: 'Missing required query parameter: url' });
    }

    // URLの簡易バリデーション（httpまたはhttpsのみ）
    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('Invalid protocol');
        }
    } catch {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    try {
        const upstream = await fetch(targetUrl, {
            headers: {
                // ブラウザに近いUser-Agentを設定して弾かれないようにする
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
                'Referer': parsedUrl.origin + '/',
            },
        });

        // CORSヘッダーを設定
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

        // Content-Typeをアップストリームから引き継ぐ
        const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);

        // HTMLレスポンスの場合：<base>タグをインジェクションしてiframe内のリソース解決を助ける
        if (contentType.includes('text/html')) {
            const bodyBuffer = await upstream.arrayBuffer();
            const bodyBytes = Buffer.from(bodyBuffer);

            // Shift-JISをUTF-8に変換（Node.jsのBufferはUTF-8なのでTextDecoderを使用）
            const decoder = new TextDecoder('shift-jis');
            let htmlText = decoder.decode(bodyBytes);

            // <head>の直後に<base>タグを挿入
            const baseTag = `<base href="${parsedUrl.origin}${parsedUrl.pathname.replace(/[^/]*$/, '')}">`;

            if (htmlText.includes('<head>')) {
                htmlText = htmlText.replace('<head>', `<head>\n    ${baseTag}`);
            } else if (htmlText.includes('<HEAD>')) {
                htmlText = htmlText.replace('<HEAD>', `<HEAD>\n    ${baseTag}`);
            } else {
                // <head>がない場合は先頭に追加
                htmlText = baseTag + '\n' + htmlText;
            }

            // UTF-8として返す（ブラウザ側のTextDecoderと合わせるためcharset変換）
            // フロントエンド側でarrayBuffer→TextDecoder('shift-jis')で処理しているため、
            // バイト列のままで返す必要がある。UTF-8変換はしない。
            res.setHeader('Content-Type', 'text/html; charset=Shift_JIS');
            return res.status(upstream.status).send(bodyBytes);
        }

        // HTML以外（画像等）はバッファをそのまま転送
        const bodyBuffer = await upstream.arrayBuffer();
        return res.status(upstream.status).send(Buffer.from(bodyBuffer));

    } catch (error) {
        console.error('[proxy] Fetch error:', error);
        return res.status(502).json({
            error: 'Bad Gateway',
            message: error.message,
        });
    }
}

// api/admin.js
// 管理者専用API：合言葉（アクセスキー）のCRUD操作
import { createClient } from '@vercel/kv';

const kv = createClient({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const KEY_SET_NAME = 'peta2:authorized_keys';

export default async function handler(req, res) {
    // 許可するHTTPメソッド: POSTのみ（セキュリティのため）
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const adminPassword = req.headers['x-admin-password'];
    const MASTER_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

    // 管理者パスワード未設定、または不一致の場合（空白は無視する）
    const trimmedMasterPassword = MASTER_ADMIN_PASSWORD ? MASTER_ADMIN_PASSWORD.trim() : null;
    const trimmedInputPassword = adminPassword ? adminPassword.trim() : null;

    if (!trimmedMasterPassword || trimmedInputPassword !== trimmedMasterPassword) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Admin Password' });
    }

    const { action, key } = req.body;

    try {
        switch (action) {
            case 'list': {
                // 合言葉の一覧を取得
                const keys = await kv.smembers(KEY_SET_NAME);
                return res.status(200).json({ keys: keys.sort() });
            }

            case 'add': {
                // 新しい合言葉を追加
                if (!key || key.trim().length < 3) {
                    return res.status(400).json({ error: 'Invalid key: Too short' });
                }
                await kv.sadd(KEY_SET_NAME, key.trim());
                return res.status(200).json({ message: 'Key added successfully' });
            }

            case 'delete': {
                // 指定した合言葉を削除
                if (!key) {
                    return res.status(400).json({ error: 'Key is required for deletion' });
                }
                await kv.srem(KEY_SET_NAME, key);
                return res.status(200).json({ message: 'Key deleted successfully' });
            }

            default:
                return res.status(400).json({ error: 'Unknown action' });
        }
    } catch (error) {
        console.error('[admin-api] Error:', error);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
}

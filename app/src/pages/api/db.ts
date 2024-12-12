

import { pool } from "@/db";

export default async function handler(req: any, res: any) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method not allowed' });
    }

    try {
        // TODO .....
        const result = await pool.query(req.body.query, req.body.params);
        res.status(200).json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error });
    } finally {

    }
}
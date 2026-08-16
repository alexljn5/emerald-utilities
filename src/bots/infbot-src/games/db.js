const mariadb = require('mariadb');

const pool = mariadb.createPool({
    host: '127.0.0.1',      // your MariaDB host
    user: 'infbot',         // DB username
    password: 'password',   // DB password
    database: 'infbot_game',
    connectionLimit: 5
});

module.exports = {
    query: async (sql, params) => {
        let conn;
        try {
            conn = await pool.getConnection();
            const res = await conn.query(sql, params);
            return res;
        } catch (err) {
            console.error('[DB] Query error:', err);
            throw err;
        } finally {
            if (conn) conn.release();
        }
    }
};
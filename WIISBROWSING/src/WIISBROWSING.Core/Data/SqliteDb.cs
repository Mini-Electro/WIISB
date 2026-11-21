using Microsoft.Data.Sqlite;

namespace WIISBROWSING.Core.Data;

/// <summary>
/// One SQLite file with versioned migrations. A single connection guarded by a lock keeps writes ordered;
/// WAL + a transaction per logical change keeps the file consistent if the app is killed mid-write.
/// </summary>
public sealed class SqliteDb : IDisposable
{
    private readonly SqliteConnection _conn;
    private readonly object _gate = new();

    public string Path { get; }

    private SqliteDb(string path, SqliteConnection conn) { Path = path; _conn = conn; }

    public static SqliteDb Open(string path, IReadOnlyList<string> migrations)
    {
        bool memory = path == ":memory:";
        if (!memory) Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        var csb = new SqliteConnectionStringBuilder { DataSource = path, Mode = SqliteOpenMode.ReadWriteCreate, Pooling = false };
        var conn = new SqliteConnection(csb.ToString());
        conn.Open();
        var db = new SqliteDb(path, conn);
        try
        {
            db.Exec("PRAGMA foreign_keys = ON");
            if (!memory) db.Exec("PRAGMA journal_mode = WAL");
            db.Exec("PRAGMA synchronous = NORMAL");
            db.Exec("PRAGMA busy_timeout = 5000");
            db.Migrate(migrations);
            return db;
        }
        catch
        {
            conn.Dispose(); // never leave the file locked when opening fails
            throw;
        }
    }

    public int Version => (int)(long)ScalarObj("PRAGMA user_version")!;

    private void Migrate(IReadOnlyList<string> migrations)
    {
        int current = Version;
        if (current > migrations.Count)
            throw new InvalidOperationException($"This browser data was written by a newer WIISBROWSING (schema {current}).");
        if (current == migrations.Count) return;

        // Keep a copy of the data from before the upgrade (never for a brand-new file).
        if (current > 0 && Path != ":memory:")
        {
            try
            {
                Exec("PRAGMA wal_checkpoint(TRUNCATE)");
                File.Copy(Path, $"{Path}.bak-v{current}", overwrite: true);
            }
            catch (IOException) { /* a backup is a courtesy; the migration below is transactional */ }
        }

        for (int v = current; v < migrations.Count; v++)
        {
            lock (_gate)
            {
                using var tx = _conn.BeginTransaction();
                using (var cmd = _conn.CreateCommand())
                {
                    cmd.Transaction = tx;
                    cmd.CommandText = migrations[v];
                    cmd.ExecuteNonQuery();
                }
                using (var cmd = _conn.CreateCommand())
                {
                    cmd.Transaction = tx;
                    cmd.CommandText = $"PRAGMA user_version = {v + 1}";
                    cmd.ExecuteNonQuery();
                }
                tx.Commit();
            }
        }
    }

    private static void Bind(SqliteCommand cmd, (string, object?)[] args)
    {
        foreach (var (name, value) in args)
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
    }

    public int Exec(string sql, params (string, object?)[] args)
    {
        lock (_gate)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = sql;
            Bind(cmd, args);
            return cmd.ExecuteNonQuery();
        }
    }

    public object? ScalarObj(string sql, params (string, object?)[] args)
    {
        lock (_gate)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = sql;
            Bind(cmd, args);
            var v = cmd.ExecuteScalar();
            return v is DBNull ? null : v;
        }
    }

    public long Long(string sql, params (string, object?)[] args) => Convert.ToInt64(ScalarObj(sql, args) ?? 0L);

    public string? String(string sql, params (string, object?)[] args) => ScalarObj(sql, args)?.ToString();

    public long LastInsertId() => Long("SELECT last_insert_rowid()");

    public List<T> Query<T>(string sql, Func<SqliteDataReader, T> map, params (string, object?)[] args)
    {
        lock (_gate)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = sql;
            Bind(cmd, args);
            using var r = cmd.ExecuteReader();
            var list = new List<T>();
            while (r.Read()) list.Add(map(r));
            return list;
        }
    }

    /// <summary>Runs <paramref name="work"/> in one transaction; rolls back if it throws.</summary>
    public void Transaction(Action<Tx> work)
    {
        lock (_gate)
        {
            using var tx = _conn.BeginTransaction();
            try
            {
                work(new Tx(_conn, tx));
                tx.Commit();
            }
            catch
            {
                tx.Rollback();
                throw;
            }
        }
    }

    public void Vacuum()
    {
        lock (_gate)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "VACUUM";
            cmd.ExecuteNonQuery();
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            try { using var c = _conn.CreateCommand(); c.CommandText = "PRAGMA wal_checkpoint(TRUNCATE)"; c.ExecuteNonQuery(); } catch { /* closing anyway */ }
            _conn.Dispose();
        }
    }

    public sealed class Tx
    {
        private readonly SqliteConnection _conn;
        private readonly SqliteTransaction _tx;
        internal Tx(SqliteConnection conn, SqliteTransaction tx) { _conn = conn; _tx = tx; }

        public int Exec(string sql, params (string, object?)[] args)
        {
            using var cmd = _conn.CreateCommand();
            cmd.Transaction = _tx;
            cmd.CommandText = sql;
            Bind(cmd, args);
            return cmd.ExecuteNonQuery();
        }

        public long LastInsertId()
        {
            using var cmd = _conn.CreateCommand();
            cmd.Transaction = _tx;
            cmd.CommandText = "SELECT last_insert_rowid()";
            return Convert.ToInt64(cmd.ExecuteScalar());
        }
    }
}

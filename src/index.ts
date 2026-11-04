import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pkg from "pg";
const { Pool } = pkg;

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Conexão com o PostgreSQL (use um usuário só de leitura no DATABASE_URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

// Cria uma instância nova do servidor MCP para cada requisição (modo stateless).
// Assim não há conflito entre conexões diferentes (navegador, Claude, etc.).
function createServer() {
  const server = new Server(
    { name: "postgres-mcp-server", version: "1.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_tables",
        description: "Lista todas as tabelas do banco (todos os schemas, exceto os do sistema) com as respectivas colunas.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "query_database",
        description: "Executa uma consulta SQL somente leitura (SELECT) no PostgreSQL.",
        inputSchema: {
          type: "object",
          properties: {
            sql: { type: "string", description: "A consulta SQL SELECT a ser executada." }
          },
          required: ["sql"]
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "list_tables") {
      const res = await pool.query(`
        SELECT table_schema, table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name, ordinal_position;
      `);
      return { content: [{ type: "text", text: JSON.stringify(res.rows, null, 2) }] };
    }

    if (name === "query_database") {
      const sql = String(args?.sql || "").trim();
      if (!/^(select|with)\b/i.test(sql)) {
        throw new Error("Apenas consultas SELECT são permitidas.");
      }
      const client = await pool.connect();
      try {
        // Transação somente leitura: bloqueia INSERT/UPDATE/DELETE/DROP mesmo se escaparem do filtro acima
        await client.query("BEGIN TRANSACTION READ ONLY");
        const res = await client.query(sql);
        await client.query("ROLLBACK");
        const rows = Array.isArray(res) ? res.at(-1)?.rows : res.rows;
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    throw new Error(`Ferramenta não encontrada: ${name}`);
  });

  return server;
}

// Endpoint MCP (transporte Streamable HTTP)
app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Erro ao processar requisição MCP:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Erro interno" }, id: null });
    }
  }
});

// No modo stateless, GET e DELETE não são usados
const notAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0", error: { code: -32000, message: "Método não permitido." }, id: null
  });
};
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

// Rota simples para "acordar" o servidor no Render e checar se está no ar
app.get("/", (_req, res) => res.send("Servidor MCP PostgreSQL ativo. Endpoint: /mcp"));

app.listen(PORT, () => {
  console.log(`Servidor MCP PostgreSQL ativo na porta ${PORT}`);
});
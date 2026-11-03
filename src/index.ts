import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pkg from "pg";
const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração da ligação PostgreSQL via variável de ambiente
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

// Inicialização do servidor MCP
const server = new Server(
  { name: "postgres-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Definição das ferramentas disponibilizadas ao Claude
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_tables",
        description: "Lista todas as tabelas disponíveis no esquema público do PostgreSQL com as respetivas colunas.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "query_database",
        description: "Executa uma consulta SQL em modo apenas de leitura (SELECT) no PostgreSQL.",
        inputSchema: {
          type: "object",
          properties: {
            sql: { type: "string", description: "A consulta SQL SELECT a ser executada." }
          },
          required: ["sql"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "list_tables") {
    const query = `
      SELECT table_name, column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
      ORDER BY table_name, ordinal_position;
    `;
    const res = await pool.query(query);
    return { content: [{ type: "text", text: JSON.stringify(res.rows, null, 2) }] };
  }

  if (name === "query_database") {
    const sql = String(args?.sql || "");
    if (!sql.trim().toLowerCase().startsWith("select")) {
      throw new Error("Apenas consultas SELECT são permitidas por motivos de segurança.");
    }
    const res = await pool.query(sql);
    return { content: [{ type: "text", text: JSON.stringify(res.rows, null, 2) }] };
  }

  throw new Error(`Ferramenta não encontrada: ${name}`);
});

// Endpoints HTTP/SSE exigidos pelo conector personalizado do Claude
let transport: SSEServerTransport;

app.get("/sse", async (req, res) => {
  transport = new SSEServerTransport("/message", res);
  await server.connect(transport);
});

app.post("/message", async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("Sessão SSE não inicializada.");
  }
});

app.listen(PORT, () => {
  console.log(`Servidor MCP PostgreSQL ativo na porta ${PORT}`);
});
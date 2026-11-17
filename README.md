# Loja Adega (Vercel + Supabase)

Loja online mobile-first com **painel administrativo protegido (senha + 2FA)**, **banco PostgreSQL no Supabase**, fotos no **Supabase Storage**, atualização para todos os visitantes e **pedido enviado por WhatsApp** (cliente sem cadastro).

> Use apenas com produtos de venda legal. A venda de bebidas alcoólicas é proibida para menores de 18 anos e a de cigarros eletrônicos é proibida no Brasil. A conformidade legal é responsabilidade de quem opera a loja.

## Como funciona

- `public/index.html`: a loja e o painel (`/admin/login`, `/admin`).
- `api/[...path].js` + `lib/handler.js`: API em funções da Vercel. **É a única parte que fala com o banco**, usando a chave `service_role`. O navegador nunca recebe essa chave.
- Supabase: tabelas com **RLS ligado**. As tabelas sensíveis (administradores, sessões, pedidos, auditoria) não têm nenhuma política, então as chaves públicas não acessam nada nelas. O catálogo tem só leitura pública (para o Realtime).
- Atualização para todos: ao salvar no painel, o banco muda; os visitantes recebem pelo **Supabase Realtime** e, como reserva, a loja consulta a API a cada 15 segundos. Não precisa novo deploy.

## Passo a passo

### 1) Supabase
1. Crie um projeto em supabase.com.
2. **SQL Editor → New query**, cole o conteúdo de `supabase/schema.sql` e clique em **Run**. Isso cria as tabelas, o RLS, o Realtime e o bucket de imagens `produtos`.
3. **Project Settings → API**: copie a *Project URL*, a chave pública (`sb_publishable_…` ou `anon`) e a chave secreta (`sb_secret_…` ou `service_role`). As chaves antigas `anon`/`service_role` serão desativadas pelo Supabase até o fim de 2026; prefira as novas.

### 2) GitHub
Envie esta pasta para um repositório (o `.gitignore` já ignora o `.env`).

### 3) Vercel
1. **Add New → Project** e importe o repositório. *Framework Preset*: **Other**. *Output Directory*: `public`.
2. Em **Environment Variables**, cadastre: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `ADMIN_USER` (`Cnobre`), `ADMIN_PASSWORD` (mín. 10 caracteres) e, se quiser, `WHATSAPP`.
3. **Deploy**.

### 4) Primeiro acesso
1. Abra `https://SEU-SITE.vercel.app/admin/login` e entre com `Cnobre` e a senha definida.
2. O painel obriga cadastrar a verificação em duas etapas (QR code no Google/Microsoft Authenticator).
3. Em **Loja**, informe o WhatsApp (55 + DDD + número), a taxa de entrega e, se quiser, a taxa por bairro.
4. Cadastre categorias e produtos. A loja começa **vazia** (sem produtos falsos).

O administrador é criado automaticamente na primeira chamada à API, a partir de `ADMIN_USER` e `ADMIN_PASSWORD`. Não existe cadastro público de administradores.

## Segurança

- Senha com hash scrypt; sessão em cookie `HttpOnly` + `SameSite=Strict` + `Secure`, token guardado como hash, expira em 8 h.
- 2FA TOTP obrigatório, com proteção contra reutilização do código.
- Limite de tentativas de login (8 por 10 min por IP), guardado no banco (funciona em funções sem estado).
- Todas as rotas `/api/admin/*` exigem sessão e 2FA; escritas exigem cabeçalho anti-CSRF e checagem de origem.
- Validação de todos os campos no servidor; upload só aceita imagens (verifica o conteúdo).
- Registro de atividades na aba **Segurança e acesso**.
- RLS ligado em todas as tabelas; `service_role` somente em variáveis de ambiente.

**Limitações**: a página usa Babel e Tailwind por CDN (exige `unsafe-eval` na CSP; o ideal é compilar com Vite). Fotos acima de 1,2 MB são reduzidas no navegador antes do envio (limite de corpo da Vercel ≈ 4,5 MB). Não há pagamento online.

## Problemas comuns

- **Erro 500 "Servidor sem configuração"**: faltam variáveis de ambiente na Vercel (depois de cadastrar, faça um novo deploy).
- **Esqueceu a senha ou perdeu o celular do 2FA**: no seu computador, com as variáveis do Supabase e `ADMIN_PASSWORD` novo definidas, rode `npm run reset-admin` (desativa o 2FA; um novo será pedido).
- **Atualização não aparece na hora**: confira `SUPABASE_ANON_KEY`; sem Realtime a loja ainda atualiza em até 15 s.

## Testes

`npm test` roda 49 verificações de API contra um **Supabase simulado** (`tests/mock-supabase.js`), sem internet. **Atenção:** o simulador foi escrito junto com o código e não substitui um teste contra o Supabase real e a Vercel, que ainda precisa ser feito por você no primeiro deploy.

## Licença

MIT.

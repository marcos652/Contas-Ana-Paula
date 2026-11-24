# Controle financeiro pessoal

Site com lançamentos a receber e a pagar por mês, colunas dinâmicas, tema e cards personalizáveis, exportação em PDF e Excel, e a aba "Clientes e notas" para MEI (mensalidades, limite anual, recibo, relatório mensal e preparo da nota). Os dados ficam no Supabase.

## 1. Preparar o Supabase (uma vez)
1. Abra o projeto no Supabase > **SQL Editor** > **New query**.
2. Cole o conteúdo de `supabase.sql` e clique em **Run**. Isso cria as tabelas e as regras para cada pessoa ver só os próprios dados.
3. **Authentication > Providers > Email**: decida se quer exigir confirmação de e-mail. Ligada, é mais segura, mas o envio de e-mails do plano gratuito é limitado. Desligada, a pessoa entra logo após criar a conta.
4. Depois de publicar o site, em **Authentication > URL Configuration**, coloque o endereço do site em **Site URL** e em **Redirect URLs**.

O arquivo `supabase-config.js` já aponta para o projeto e usa só a chave pública. Nunca coloque ali a chave `secret` nem a `service_role`.

## 2. Rodar no computador
```bash
npm install
npm run dev -- --port 3000
```
No Windows, o `iniciar.bat` faz isso com dois cliques.

## 3. Publicar (gratuito)
```bash
npm run build
```
Envie a pasta `dist` para um serviço de hospedagem estática gratuito, como Cloudflare Pages, Netlify ou Vercel. Depois faça o passo 1.4 com o endereço que eles derem.

## Cuidados
- No plano gratuito do Supabase, projetos ficam pausados depois de um tempo sem uso. Entre no site de vez em quando e, se pausar, reative no painel.
- Sem o Supabase configurado, o site funciona salvando só no navegador.
- O site não emite nota fiscal sozinho. A aba "Clientes e notas" prepara os dados para a emissão no sistema oficial.

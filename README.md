# Mercado-Livre-MCP

Dois servidores MCP só leitura para o Mercado Livre Brasil. Eles foram gerados pelo [Pomerado](https://github.com/Pomerado/pomerado) (open source, MIT), com o Claude no lugar dos modelos da OpenAI.

| Ferramenta | Entrada | Devolve |
| --- | --- | --- |
| `ml_busca` | `query`, `limit` (1–50, padrão 20), `cursor` | Resultados da busca na ordem do site, com `next_cursor` para a página seguinte. Cada item traz `item_id`, título, preço, preço anterior, desconto, frete grátis, patrocinado, link limpo, imagem, nota e vendedor. |
| `ml_produto` | `url`: anúncio `MLB-…`, catálogo `/p/MLB…` ou `/up/MLBU…` | Ids, título, preço geral, `pix_price`, preço anterior, desconto, parcelas, condição, vendidos, vendedor, loja oficial, frete grátis, estoque, nota, número de avaliações, imagem e URL canônica. |

Os esquemas completos ficam em `integrations/*/pomerado.json` e o extrator em `integrations/*/src/tool.mjs`. Para rodar uma integração pronta, nenhum modelo é chamado.

## Requisitos

- Node 24.21 ou mais novo, abaixo do 25 (`nvm use`).
- `npm install` e `npx patchright install chromium`.
- Um proxy residencial do Brasil com sessão fixa. O teste usou a DataImpulse. Sem proxy, o ML bloqueia o IP depois de algumas dezenas de leituras.
- Uma tela. O navegador abre com janela porque o modo headless é bloqueado; num servidor, use o Xvfb.

## Usar

1. Rode `cp .env.example .env` e preencha `PROXY_URL`.
2. Rode `npm run browser`. Ele abre um Chromium do patchright com janela e mostra o endereço WS (padrão `ws://localhost:9555/pw`).
3. Rode `npm run ip` para conferir o IP de saída antes de abrir o ML.
4. Teste as ferramentas pelo cliente MCP do repositório:

```bash
npm run call -- integrations/ml_busca '{"input":{"query":"air fryer","limit":5}}'
```

```bash
npm run call -- integrations/ml_produto '{"input":{"url":"https://www.mercadolivre.com.br/fritadeira-airfryer-xl-philips-walita-hd9206/p/MLB35612949"}}'
```

Sem o JSON, o `npm run call` só lista as ferramentas e não abre o site.

### Ligar no Claude Code

Rode na pasta do repositório, com o navegador da etapa 2 aberto:

```bash
claude mcp add ml_busca -- "$(nvm which 24)" "$PWD/node_modules/pomerado/dist/typescript/src/standalone/mcp-cli.js" serve --artifact "$PWD/integrations/ml_busca" --endpoint ws://localhost:9555/pw
```

```bash
claude mcp add ml_produto -- "$(nvm which 24)" "$PWD/node_modules/pomerado/dist/typescript/src/standalone/mcp-cli.js" serve --artifact "$PWD/integrations/ml_produto" --endpoint ws://localhost:9555/pw
```

Em outros clientes, a configuração é a mesma: o comando é o Node 24 e os argumentos são os que aparecem acima.

### Como uma chamada funciona

A ferramenta principal (`ml_busca` ou `ml_produto`) recebe os argumentos dentro de `input` e devolve um job. O cliente consulta `get_job` com o `job_id` até o resultado chegar. Se o mint tiver deixado perguntas, elas chegam por `provide_input`.

Cada chamada abre um contexto novo do navegador e lê duas páginas: a home e a página pedida. No teste, uma chamada levou de 20 a 30 segundos.

## Anti-robô

- Quando um IP lê demais, o ML redireciona para `/gz/account-verification`, a tela de login. O mint faz dezenas de leituras e queimou primeiro o IP de casa e depois o IP fixo do proxy. Para sair disso, troque o `SID`, o que dá um IP novo, e reinicie o `npm run browser`.
- Não leia o ML pelo IP de casa.
- Só passou o patchright com janela, ligado por `--endpoint`. O Playwright headless levou 403, e o Playwright com janela caiu no captcha.

## Recriar ou mudar uma integração (mint com Claude)

O mint do Pomerado só conversa com a Responses API da OpenAI, e os modelos `gpt-6.1-sol` e `gpt-6-luna` são fixos no código. O `bridge/bridge.mjs` atende essa API em `127.0.0.1:9777` e responde com o Claude: o sol vira `claude-opus-5-5` e o luna vira `claude-haiku-5-5`. Para trocar, use `SOL_MODEL` e `LUNA_MODEL`.

1. Preencha no `.env` a `ANTHROPIC_API_KEY` (ou a `ANTHROPIC_API_KEY_FILE`) e o `BUDGET_USD`.
2. Rode `npm run bridge`. Os logs ficam em `logs/bridge/`, com o custo de cada chamada em `bridge.jsonl`.
3. Se quiser, rode `npm run smoke:bridge`, que custa centavos.
4. Abra o navegador com um `SID` novo: `npm run browser`.
5. Rode o mint:

```bash
OPENAI_API_KEY=bridge OPENAI_BASE_URL=http://127.0.0.1:9777/v1 npx pomerado mint --url 'https://www.mercadolivre.com.br/' --intent '<o que a ferramenta faz>' --input '{"query":"fone bluetooth","limit":10}' --out integrations/ml_nova --effect read --endpoint ws://localhost:9555/pw --timeout-seconds 2400
```

6. Responda no próprio terminal as perguntas que o mint fizer.
7. Escreva o `deployment.json` à mão (`name`, `description` e `request.url/intent/effect`), copiando o modelo das integrações que já existem. O CLI não grava esse arquivo, e o `pomerado-mcp serve` precisa dele.

Para acompanhar o custo e as respostas do Pomerado durante o mint, rode `node scripts/watch-mint.mjs logs/bridge <log-do-mint>` com a saída do mint gravada num arquivo.

Cuidados:

- O `--timeout-seconds` padrão, de 1200 s, matou a primeira tentativa durante a revisão final. Use 2400.
- O Guardian (Haiku) recusa perguntas desnecessárias e afirmações sem teste na descrição da ferramenta.

<details>
<summary>Intenções usadas no mint</summary>

`ml_busca`, com `--input '{"query":"fone bluetooth","limit":10}'`:

> Search Mercado Livre Brazil for a search term and return the products listed on the first page of results. Input: the search term and an optional maximum number of results (default 20). For each product return: title, current price in BRL as a number, the previous (crossed-out) price in BRL as a number or null, the discount percent shown or null, whether it has free shipping (frete grátis), whether it is sponsored (Patrocinado), the product URL without tracking parameters, and the main image URL. Read only: never sign in, add to cart or buy.

`ml_produto`, com `--input '{"url":"https://produto.mercadolivre.com.br/MLB-4809275082"}'`:

> Read one Mercado Livre Brazil product page and return its details. Input: the product URL, either a listing link (produto.mercadolivre.com.br/MLB-...) or a catalog link (www.mercadolivre.com.br/.../p/MLB...). Return: the listing item id, the catalog product id or null, title, current price in BRL as a number, the previous (crossed-out) price as a number or null, the discount percent or null, the Pix price when the page shows a different price for paying with Pix (or null), the installments text as shown, condition (new or used), seller name, whether it is an official store, whether shipping is free, the stock or availability text, rating and number of reviews or null, the main image URL and the canonical product URL. Read only: never sign in, add to cart or buy.

</details>

### O que a ponte traduz

- O `apply_patch` nativo (diff V4A) vira uma ferramenta comum com `type`, `path` e `diff`.
- O raciocínio criptografado vira os blocos thinking do Claude, guardados em `encrypted_content` na ida e na volta. Isso usa o beta `thinking-binding-controls-2026-08-01` com `drop_block`.
- Os esquemas estritos do Guardian perdem `maxItems` e os limites numéricos, que o Claude recusa. Se ainda assim falhar, o esquema vai no prompt.
- A compactação (`compaction_trigger`) vira um resumo do Claude num item `compaction`, que guarda o system original.
- O `allowed_tools` é ignorado, porque mudar o conjunto de ferramentas invalida o cache e o thinking.
- Não há streaming.
- Quando o gasto passa do `BUDGET_USD`, a ponte responde 429 `insufficient_quota`.

## Resultado do teste (29/10/2026)

- `ml_busca` com "air fryer": 5 resultados em 31 s.
- `ml_produto` com `/p/MLB42225245`: 21,5 s. Voltaram preço de R$ 531,99, Pix de R$ 478,79, "de" R$ 849,86, 43 % de desconto, loja oficial e 16.003 avaliações.
- O mint custou US$ 11,76 no total: Opus US$ 11,41 em 123 chamadas e Haiku US$ 0,35 em 96. Desse total, cerca de US$ 4,87 foram da primeira tentativa, perdida por tempo. O `ml_busca` saiu por cerca de US$ 4,58 e o `ml_produto` por cerca de US$ 2,31.
- Os preços das duas ferramentas não significam a mesma coisa. O `price` da busca é o preço principal do card, que é o do Pix quando aparece. O `price` do produto é o preço geral, com o Pix à parte em `pix_price`.

## Licença

O Pomerado é MIT (Pomerado AI, Inc.). Este repositório é privado.

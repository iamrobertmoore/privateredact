/* Offline sanity checks for the pure logic in app.js (no browser needed). */
const assert = require('assert');
const { luhnValid, findAll, parseJsonLoose, sanitize, extractResponseText, RULES } = require('../app.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('ok   -', name); }
  catch (e) { fail++; console.error('NOT ok -', name, '\n     ', e.message); }
}

t('luhn valid card', () => assert.strictEqual(luhnValid('4242 4242 4242 4242'), true));
t('luhn invalid card', () => assert.strictEqual(luhnValid('1234 5678 9012 3456'), false));

t('findAll multiple', () => { const s = findAll('a cat and a cat', 'cat'); assert.strictEqual(s.length, 2); assert.strictEqual(s[0].start, 2); });
t('findAll ci fallback', () => { const s = findAll('Acme and ACME', 'acme'); assert.ok(s.length >= 1); });

t('parseJsonLoose fenced', () => { const o = parseJsonLoose('```json\n{"redactions":[{"text":"x"}]}\n```'); assert.strictEqual(o.redactions[0].text, 'x'); });
t('parseJsonLoose embedded', () => { const o = parseJsonLoose('sure: {"a":1} done'); assert.strictEqual(o.a, 1); });

t('sanitize preserves length', () => { const inp = 'a’b—c…😀'; assert.strictEqual(sanitize(inp).length, inp.length); });
t('sanitize maps smart quote', () => assert.strictEqual(sanitize('’'), "'"));

t('extractResponseText output_text', () => assert.strictEqual(extractResponseText({ output_text: 'hi' }), 'hi'));
t('extractResponseText message array', () => { const d = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'yo' }] }] }; assert.strictEqual(extractResponseText(d), 'yo'); });

t('email rule matches', () => { const m = 'reach me at a@b.com now'.match(RULES.email.re()); assert.strictEqual(m[0], 'a@b.com'); });
t('ssn rule matches', () => { const m = '123-45-6789'.match(RULES.ssn.re()); assert.strictEqual(m[0], '123-45-6789'); });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/* LegalSpeech 2026-11-25.1
 * Speech-only preprocessing. Never assign the result back to the displayed law text.
 * Usage: LegalSpeech.chunk(LegalSpeech.prepare(originalText)).
 * Dictionary correction reduces common errors; voice, prosody and quality depend on the device.
 */
(function (root) {
  'use strict';
  const dictionaryVersion = '2026-11-25.1';
  // Multi-character legal expressions only. One replacement pass, longest matches first.
  // Context-sensitive expressions and numerals are handled separately below.
  const dictionary = [
    ['特許法施行規則','とっきょほうしこうきそく'],['特許法施行令','とっきょほうしこうれい'],
    ['実用新案法施行規則','じつようしんあんほうしこうきそく'],['実用新案法施行令','じつようしんあんほうしこうれい'],
    ['意匠法施行規則','いしょうほうしこうきそく'],['意匠法施行令','いしょうほうしこうれい'],
    ['商標法施行規則','しょうひょうほうしこうきそく'],['商標法施行令','しょうひょうほうしこうれい'],
    ['著作権法施行規則','ちょさくけんほうしこうきそく'],['著作権法施行令','ちょさくけんほうしこうれい'],
    ['工業所有権に関する手続等の特例に関する法律','こうぎょうしょゆうけんにかんするてつづきとうのとくれいにかんするほうりつ'],
    ['特許協力条約','とっきょきょうりょくじょうやく'],['不正競争防止法','ふせいきょうそうぼうしほう'],
    ['実用新案法','じつようしんあんほう'],['特許法','とっきょほう'],['意匠法','いしょうほう'],
    ['商標法','しょうひょうほう'],['著作権法','ちょさくけんほう'],['弁理士法','べんりしほう'],
    ['民事訴訟法','みんじそしょうほう'],['行政事件訴訟法','ぎょうせいじけんそしょうほう'],
    ['日本国憲法','にほんこくけんぽう'],['民法','みんぽう'],['刑法','けいほう'],
    ['パリ条約','ぱりじょうやく'],['ベルヌ条約','べるぬじょうやく'],['ハーグ協定','はーぐきょうてい'],
    ['マドリッド協定議定書','まどりっどきょうていぎていしょ'],
    ['内国民待遇','ないこくみんたいぐう'],['最恵国待遇','さいけいこくたいぐう'],
    ['工業所有権','こうぎょうしょゆうけん'],['産業財産権','さんぎょうざいさんけん'],
    ['知的財産権','ちてきざいさんけん'],['知的所有権','ちてきしょゆうけん'],
    ['拒絶査定不服審判','きょぜつさていふふくしんぱん'],['補正却下決定不服審判','ほせいきゃっかけっていふふくしんぱん'],
    ['特許無効審判','とっきょむこうしんぱん'],['訂正審判','ていせいしんぱん'],['不使用取消審判','ふしようとりけししんぱん'],
    ['審決取消訴訟','しんけつとりけしそしょう'],['拒絶理由通知','きょぜつりゆうつうち'],
    ['実用新案技術評価書','じつようしんあんぎじゅつひょうかしょ'],['実用新案技術評価','じつようしんあんぎじゅつひょうか'],
    ['特許請求の範囲','とっきょせいきゅうのはんい'],['実用新案登録請求の範囲','じつようしんあんとうろくせいきゅうのはんい'],
    ['新規性喪失の例外','しんきせいそうしつのれいがい'],['新規性の喪失','しんきせいのそうしつ'],
    ['発明の単一性','はつめいのたんいつせい'],['先願主義','せんがんしゅぎ'],['先発明主義','せんはつめいしゅぎ'],
    ['拡大先願','かくだいせんがん'],['先使用権','せんしようけん'],['冒認出願','ぼうにんしゅつがん'],
    ['通常実施権','つうじょうじっしけん'],['専用実施権','せんようじっしけん'],
    ['通常使用権','つうじょうしようけん'],['専用使用権','せんようしようけん'],
    ['仮通常実施権','かりつうじょうじっしけん'],['仮専用実施権','かりせんようじっしけん'],
    ['独占的通常実施権','どくせんてきつうじょうじっしけん'],
    ['特許権者','とっきょけんしゃ'],['実用新案権者','じつようしんあんけんしゃ'],['商標権者','しょうひょうけんしゃ'],
    ['意匠権者','いしょうけんしゃ'],['著作権者','ちょさくけんしゃ'],['著作者','ちょさくしゃ'],
    ['実用新案登録','じつようしんあんとうろく'],['実用新案権','じつようしんあんけん'],['実用新案','じつようしんあん'],
    ['特許権','とっきょけん'],['意匠権','いしょうけん'],['商標権','しょうひょうけん'],['著作権','ちょさくけん'],
    ['著作隣接権','ちょさくりんせつけん'],['著作者人格権','ちょさくしゃじんかくけん'],
    ['出願審査請求','しゅつがんしんさせいきゅう'],['出願人','しゅつがんにん'],['請求人','せいきゅうにん'],
    ['被請求人','ひせいきゅうにん'],['審査官','しんさかん'],['審判官','しんぱんかん'],
    ['特許庁長官','とっきょちょうちょうかん'],['特許庁','とっきょちょう'],['弁理士試験','べんりししけん'],['弁理士','べんりし'],
    ['短答式','たんとうしき'],['論文式','ろんぶんしき'],['口述試験','こうじゅつしけん'],
    ['拒絶査定','きょぜつさてい'],['登録査定','とうろくさてい'],['補正却下','ほせいきゃっか'],
    ['善意無過失','ぜんいむかしつ'],['善意','ぜんい'],['悪意','あくい'],
    ['但し書き','ただしがき'],['但し書','ただしがき'],['但書き','ただしがき'],['但書','ただしがき'],
    ['ただし書き','ただしがき'],['ただし書','ただしがき'],['柱書き','はしらがき'],['柱書','はしらがき'],
    ['各号列記','かくごうれっき'],['各号','かくごう'],['各項','かくこう'],['各条','かくじょう'],
    ['前各項','ぜんかくこう'],['前各号','ぜんかくごう'],['前項','ぜんこう'],['前条','ぜんじょう'],['前号','ぜんごう'],
    ['同項','どうこう'],['同条','どうじょう'],['同号','どうごう'],['次項','じこう'],['次条','じじょう'],['本条','ほんじょう'],
    ['附則','ふそく'],['付則','ふそく'],['附記','ふき'],['施行規則','しこうきそく'],['施行令','しこうれい'],
    ['施行期日','しこうきじつ'],['施行日','しこうび'],['施行','しこう'],
    ['甲乙丙丁','こうおつへいてい'],['甲号証','こうごうしょう'],['乙号証','おつごうしょう'],['丙号証','へいごうしょう'],['丁号証','ていごうしょう'],
    ['甲乙間','こうおつかん'],['甲乙','こうおつ'],
    ['意匠','いしょう'],['冒認','ぼうにん'],['先願','せんがん'],['後願','こうがん'],['本願','ほんがん'],
    ['査定','さてい'],['拒絶','きょぜつ'],['審決','しんけつ'],['審判','しんぱん'],['謄本','とうほん'],['抄本','しょうほん'],
    ['補正','ほせい'],['却下','きゃっか'],['棄却','ききゃく'],['出訴','しゅっそ'],['抗告','こうこく'],['上告','じょうこく'],
    ['控訴','こうそ'],['抗弁','こうべん'],['瑕疵','かし'],['疎明','そめい'],['陳述','ちんじゅつ'],['証憑','しょうひょう'],
    ['差止請求','さしとめせいきゅう'],['差止め','さしとめ'],['差止','さしとめ'],['損害賠償','そんがいばいしょう'],
    ['不当利得','ふとうりとく'],['過失','かしつ'],['故意','こい'],['履行','りこう'],['債務','さいむ'],['債権','さいけん'],
    ['消尽','しょうじん'],['均等論','きんとうろん'],['属地主義','ぞくちしゅぎ'],['遡及','そきゅう'],['援用','えんよう'],
    ['専有','せんゆう'],['占有','せんゆう'],['承継','しょうけい'],['譲渡','じょうと'],['対抗要件','たいこうようけん'],
    ['創作非容易性','そうさくひよういせい'],['容易想到性','よういそうとうせい'],['当業者','とうぎょうしゃ'],
    ['新規性','しんきせい'],['進歩性','しんぽせい'],['公然実施','こうぜんじっし'],['公然','こうぜん'],['公知','こうち'],
    ['頒布','はんぷ'],['刊行物','かんこうぶつ'],['明細書','めいさいしょ'],['請求項','せいきゅうこう'],['図面','ずめん'],
    ['要約書','ようやくしょ'],['願書','がんしょ'],['設定登録','せっていとうろく'],['存続期間','そんぞくきかん'],
    ['関連意匠','かんれんいしょう'],['基礎意匠','きそいしょう'],['本意匠','ほんいしょう'],['秘密意匠','ひみついしょう'],
    ['地域団体商標','ちいきだんたいしょうひょう'],['団体商標','だんたいしょうひょう'],['防護標章','ぼうごひょうしょう'],
    ['識別力','しきべつりょく'],['称呼','しょうこ'],['観念','かんねん'],['需要者','じゅようしゃ'],['出所','しゅっしょ'],
    ['商標','しょうひょう'],['標章','ひょうしょう'],['役務','えきむ'],['周知','しゅうち'],['著名','ちょめい'],
    ['優先権','ゆうせんけん'],['優先日','ゆうせんび'],['外国語書面','がいこくごしょめん'],['翻訳文','ほんやくぶん'],
    ['複製','ふくせい'],['翻案','ほんあん'],['公衆送信','こうしゅうそうしん'],['自動公衆送信','じどうこうしゅうそうしん'],
    ['営業秘密','えいぎょうひみつ'],['秘密管理性','ひみつかんりせい'],['有用性','ゆうようせい'],['非公知性','ひこうちせい'],
    ['何ら','なんら'],['及び','および'],['又は','または'],['若しくは','もしくは'],['並びに','ならびに'],
    ['但し','ただし'],['且つ','かつ'],['遅滞なく','ちたいなく'],['直ちに','ただちに'],['予め','あらかじめ'],
    ['あつて','あって'],['あつた','あった'],['もつて','もって'],['よつて','よって'],['なつた','なった'],['なつて','なって'],
    ['とつた','とった'],['とつて','とって'],['かつた','かった']
  ];
  const table = new Map(dictionary);
  const escapeRE = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordPattern = new RegExp([...table.keys()].sort((a,b) => b.length-a.length).map(escapeRE).join('|'), 'gu');
  const numeralChars = '0-9〇零一二三四五六七八九十百千万億壱弐参';
  const numeralPattern = '[' + numeralChars + ']+';
  const kanjiDigit = { '〇':0,'零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'壱':1,'弐':2,'参':3 };
  const digitKana = ['れい','いち','に','さん','よん','ご','ろく','なな','はち','きゅう'];
  const numeralWithUnits = /[十百千万億]/;
  function parseNumeral(raw) {
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    }
    if (!numeralWithUnits.test(raw)) {
      const digits = [...raw].map(c => kanjiDigit[c]);
      if (digits.some(n => n === undefined)) return null;
      const n = Number(digits.join(''));
      return Number.isSafeInteger(n) ? n : null;
    }
    let total = 0, section = 0, value = 0;
    const small = {十:10,百:100,千:1000}, large = {万:10000,億:100000000};
    for (const c of raw) {
      if (Object.prototype.hasOwnProperty.call(kanjiDigit,c)) value = value * 10 + kanjiDigit[c];
      else if (/\d/.test(c)) value = value * 10 + Number(c);
      else if (small[c]) { section += (value || 1) * small[c]; value = 0; }
      else if (large[c]) { total += (section + value || 1) * large[c]; section = 0; value = 0; }
      else return null;
    }
    const n = total + section + value;
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  function numberKana(n) {
    if (n === 0) return 'れい';
    if (n >= 100000000) return numberKana(Math.floor(n/100000000)) + 'おく' + (n%100000000 ? numberKana(n%100000000) : '');
    if (n >= 10000) return numberKana(Math.floor(n/10000)) + 'まん' + (n%10000 ? numberKana(n%10000) : '');
    let s = '';
    const thousands = Math.floor(n/1000); n %= 1000;
    if (thousands) s += thousands===1 ? 'せん' : thousands===3 ? 'さんぜん' : thousands===8 ? 'はっせん' : digitKana[thousands]+'せん';
    const hundreds = Math.floor(n/100); n %= 100;
    if (hundreds) s += hundreds===1 ? 'ひゃく' : hundreds===3 ? 'さんびゃく' : hundreds===6 ? 'ろっぴゃく' : hundreds===8 ? 'はっぴゃく' : digitKana[hundreds]+'ひゃく';
    const tens = Math.floor(n/10); n %= 10;
    if (tens) s += (tens===1 ? '' : digitKana[tens])+'じゅう';
    if (n) s += digitKana[n];
    return s;
  }
  function countedKana(n, unit) {
    let s = numberKana(n);
    if (unit==='項' || unit==='款') {
      s = s.replace(/いち$/,'いっ').replace(/ろく$/,'ろっ').replace(/はち$/,'はっ').replace(/じゅう$/,'じゅっ').replace(/([びぴひ]ゃ)く$/,'$1っ');
    } else if (unit==='章' || unit==='節') {
      s = s.replace(/いち$/,'いっ').replace(/はち$/,'はっ').replace(/じゅう$/,'じゅっ');
    } else if (unit==='編') {
      const clipped = s.replace(/いち$/,'いっ').replace(/ろく$/,'ろっ').replace(/はち$/,'はっ').replace(/じゅう$/,'じゅっ');
      return clipped + (/っ$|さん$|せん$/.test(clipped) ? 'ぺん' : 'へん');
    }
    return s + {条:'じょう',項:'こう',号:'ごう',章:'しょう',節:'せつ',款:'かん',目:'もく'}[unit];
  }
  function readCitation(match, prefix, number, unit, branches) {
    const n = parseNumeral(number);
    if (n===null) return match;
    let result = (prefix ? 'だい' : '') + countedKana(n,unit);
    if (branches) result += branches.replace(new RegExp('\\s*の\\s*('+numeralPattern+')','gu'), (m,part) => {
      const bn = parseNumeral(part);
      return bn===null ? m : 'の'+numberKana(bn);
    });
    return result;
  }
  // Prefix required for kanji numerals: do not rewrite a surname such as 一条.
  const numberedCitation = new RegExp('(第)\\s*('+numeralPattern+')\\s*([条項号章節款目編])((?:\\s*の\\s*'+numeralPattern+')*)','gu');
  const arabicCitation = new RegExp('(?<![0-9A-Za-z])()([0-9]+)\\s*([条項号章節款目編])((?:\\s*の\\s*'+numeralPattern+')*)','gu');

  function prepareLegalSpeech(input) {
    let text = String(input ?? '');
    // Full-width digits only; do not normalize symbols or rewrite the displayed source.
    text = text.replace(/[０-９]/g, c => String(c.charCodeAt(0)-0xFF10));
    // 何人 is contextual: the legal universal/indefinite person, not a head count question.
    text = text.replace(/何人(?=も|でも|に(?:も|でも|対|おい)|が|を|の|かの|であ)/gu,'なんぴと');
    text = text.replace(/(^|[\s「『（(、。:：])何人(?=$|[\s」』）)、。:：])/gu,'$1なんぴと');
    // Do not turn 同一の or 統一の into 同いちの / 統いちの.
    text = text.replace(/(?<![一-龠々〇零0-9A-Za-z])一(?=の|又は|若しくは)/gu,'いち');
    text = text.replace(new RegExp('(?<![一-龠々〇零0-9A-Za-z])('+numeralPattern+')(?=以上|以下|未満|を超え)','gu'), (m,number) => {
      const n = parseNumeral(number); return n===null ? m : numberKana(n);
    });
    const people = {甲:'こう',乙:'おつ',丙:'へい',丁:'てい'};
    // Legal party labels only. 甲板、乙女、丙午、丁寧 and 丁目 stay untouched.
    text = text.replace(/(?<![一-龠々ァ-ヶA-Za-z0-9])([甲乙丙丁])(?=は|が|を|に|と|の|から|及び|又は|若しくは|並びに|第|[、。・\s」』）)]|$)/gu, (m,p) => people[p]);
    // A party label following another party + conjunction is also unambiguous in legal scenarios.
    text = text.replace(/([甲乙丙丁])(?=及び|又は|若しくは|並びに)/gu, (m,p) => people[p]);
    // Party labels must be processed before 第1号 is expanded to kana.
    text = text.replace(numberedCitation,readCitation).replace(arabicCitation,readCitation);
    text = text.replace(/ごう証/gu,'ごうしょう');
    text = text.replace(wordPattern, word => table.get(word));
    text = text.replace(/\b(?:PCT|TRIPS|WIPO|WTO)\b/g, token => ({PCT:'ピーシーティー',TRIPS:'トリップス',WIPO:'ワイポ',WTO:'ダブリューティーオー'})[token]);
    return text;
  }

  function chunkSpeech(input, requestedMax = 180) {
    const text = String(input ?? '');
    if (!text) return [];
    // UTF-16 length limit, including punctuation and whitespace. Never split a surrogate pair.
    const max = Math.max(2,Math.min(180,Number.isFinite(requestedMax) ? Math.floor(requestedMax) : 180));
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      if (text.length-start <= max) { chunks.push(text.slice(start)); break; }
      let end = start + max;
      if (/^[\uDC00-\uDFFF]$/.test(text.charAt(end)) && /^[\uD800-\uDBFF]$/.test(text.charAt(end-1))) end--;
      const window = text.slice(start,end);
      let boundary = 0;
      // Keep punctuation/closing marks/whitespace in their original sequence.
      const sentence = /[。！？!?][」』）】”’]*\s*|\n+/gu;
      let match;
      while ((match = sentence.exec(window))) boundary = match.index + match[0].length;
      if (!boundary) {
        const phrase = /[、，,；;：:]\s*|\s+/gu;
        while ((match = phrase.exec(window))) {
          const candidate = match.index + match[0].length;
          if (candidate >= Math.floor(max*0.4)) boundary = candidate;
        }
      }
      if (boundary) end = start + boundary;
      chunks.push(text.slice(start,end));
      start = end;
    }
    return chunks;
  }
  const sources = Object.freeze([
    {label:'厚生労働省・ふりがな付き法令資料（何人・第一条・第一項）',url:'https://www.mhlw.go.jp/bunya/shougaihoken/sougoufukusi/2011/04/dl/0502-1b09_02.pdf'},
    {label:'e-Gov・法令名よみ（第九条・第十項）',url:'https://laws.e-gov.go.jp/law/502CO0000000365'},
    {label:'e-Gov・法令名よみ（第六項）',url:'https://laws.e-gov.go.jp/law/505M60000800094'},
    {label:'e-Gov・法令名よみ（第八項）',url:'https://laws.e-gov.go.jp/law/427M60000100075'},
    {label:'裁判所・ふりがな付き説明（謄本）',url:'https://www.courts.go.jp/chiba/vc-files/chiba/2025/koken/05koken/08miseinenkoken/240siori_miseinen.pdf'},
    {label:'特許庁・用語用例（後願）',url:'https://www.jpo.go.jp/faq/yokuaru/trademark/kashi_kougan.html'}
  ]);
  root.LegalSpeech = Object.freeze({
    prepare: prepareLegalSpeech,
    chunk: chunkSpeech,
    dictionaryVersion,
    dictionarySize: dictionary.length,
    sources
  });
})(typeof window !== 'undefined' ? window : globalThis);

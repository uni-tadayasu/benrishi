#!/usr/bin/env python3
"""Build an offline treaty reader from verified official downloads / public web extracts.

PDFs are copied byte-for-byte. HTML files are explicitly labelled text extracts,
not byte-identical source HTML. Do not silently call historical treaty text current.
"""
import argparse, hashlib, html, json, re, shutil, subprocess
from pathlib import Path
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--raw', type=Path, default=Path('work/treaty-raw'))
parser.add_argument('--out', type=Path, default=Path('work/treaty-corpus'))
parser.add_argument('--report', type=Path, default=Path('work/treaty-corpus-validation.json'))
args = parser.parse_args()
RAW, OUT = args.raw, args.out
OUT.mkdir(parents=True, exist_ok=True)
args.report.parent.mkdir(parents=True, exist_ok=True)
VERIFIED = '2026-11-25'
PDFS = [
 {'id':'pct','title':'特許協力条約（PCT）','language':'ja','status':'current','sourceUrl':'https://www.wipo.int/documents/d/pct-system/docs-ja-texts-pct.pdf','editionNote':'2001年変更・2002年4月1日発効のWIPO掲載日本語仮訳。PDFの注意書きに従い、原文と相違する場合は原文が優先。'},
 {'id':'pct-regulations','title':'PCT規則（2026年1月1日施行）','language':'ja','status':'current','sourceUrl':'https://www.wipo.int/documents/d/pct-system/docs-ja-texts-pct-regs.pdf','editionNote':'WIPO掲載2026年1月1日発効版。日本語版は外務省告示に基づいて編集されたもの。'},
 {'id':'madrid-current-en','title':'マドリッド議定書・規則等（現行英語原本）','language':'en','status':'current','sourceUrl':'https://www.wipo.int/edocs/pubdocs/en/wipo-pub-207-2026-en-protocol-relating-to-the-madrid-agreement-concerning-the-international-registration-of-marks-regulations-administrative-instructions-schedule-of-fees.pdf','editionNote':'WIPO 2026年版。議定書2007年11月12日修正、規則2026年11月1日施行、実施細則・料金表2023年2月1日施行。英語原本。'},
 {'id':'berne-en','title':'ベルヌ条約（1979年修正・英語原本）','language':'en','status':'current','sourceUrl':'https://www.wipo.int/edocs/pubdocs/en/wipo_pub_287-accessible1.pdf','editionNote':'1971年パリ改正・1979年9月28日修正を反映したWIPO掲載英語版。附属書を含む。'},
 {'id':'plt-en','title':'特許法条約・規則等（PLT・英語原本）','language':'en','status':'current','sourceUrl':'https://www.wipo.int/edocs/pubdocs/en/wipo_pub_258.pdf','editionNote':'WIPO掲載2006年版。2000年特許法条約、2006年1月1日施行の規則及び説明注を含む。説明注は条約本文と区別して参照。英語原本。'},
 {'id':'hague-current-en','title':'ハーグ・ジュネーブ改正協定・規則等（現行英語原本）','language':'en','status':'current','sourceUrl':'https://www.wipo.int/edocs/pubdocs/en/wipo-pub-269-2026-en-hague-agreement-concerning-the-international-registration-of-industrial-designs.pdf','editionNote':'WIPO 2026年版。1999年ジュネーブ改正協定、2026年7月1日施行の規則、2025年7月17日施行の実施細則。英語原本。'},
]
HTMLS = [
 {'id':'paris','title':'パリ条約（1967年改正・旧版参考）','status':'historical','editionNote':'外務省の1967年ストックホルム改正掲載版。1979年修正を統合した現行版ではありません。改正前資料として参照してください。','expectedArticles':46},
 {'id':'trips','title':'TRIPS協定（附属書を含む）','status':'reference','editionNote':'外務省2017年1月26日掲載本文。第31条の2・附属書・附属書の付録を含む。項号の表示はHTMLからの抽出形式であり、正文の組版とは異なります。','expectedArticles':74},
 {'id':'tlt','title':'商標法条約・規則（TLT）','status':'reference','editionNote':'外務省掲載の1994年商標法条約25条及び8規則。掲載HTMLの本文を収録。出願様式の原本はこのHTMLには含まれません。','expectedArticles':33},
 {'id':'wct','title':'WIPO著作権条約（WCT）','status':'reference','editionNote':'外務省掲載日本語本文25条。掲載HTMLに付属しない合意声明はこの資料には含めていません。','expectedArticles':25},
 {'id':'wppt','title':'WIPO実演・レコード条約（WPPT）','status':'reference','editionNote':'外務省掲載日本語本文33条。掲載HTMLに付属しない合意声明はこの資料には含めていません。','expectedArticles':33},
 {'id':'madrid','title':'マドリッド議定書（1989年採択・旧版参考）','status':'historical','editionNote':'外務省掲載の1989年採択版。2006年・2007年修正前であり、第9条の6などが現行制度と異なります。現行学習には「現行英語原本」を参照してください。','expectedArticles':26},
]

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def save_json(path, data): path.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
def clean_line(s): return re.sub(r'[ \t]+',' ',s).strip()
def article(id, title, text, caption='', section='条約', **kw):
    return {'id':id,'title':title,'caption':caption,'section':section,'paragraphs':[{'number':'','text':p}for p in text.split('\n')if p.strip()],'text':text,**kw}

manifest={'verifiedAt':VERIFIED,'scopeNote':'指定した12資料の公式PDF又は公式掲載本文の保存版を収録。日本語8資料・英語4資料。パリ条約及びマドリッド議定書の日本語資料は旧版参考で、現行版ではありません。全条約・全改正・全関連文書の網羅を意味しません。PDFはページ単位、HTML本文は条文単位で検索・参照できます。','treaties':[],'files':[],'excluded':[
 {'id':'hague-ja','title':'ハーグ・ジュネーブ改正協定及び規則の日本語原本','reason':'公式日本語PDFの直接取得が403のため未収録。現行WIPO英語原本を収録。','sourceUrl':'https://www.jpo.go.jp/system/design/hague/kisoku/index.html'},
 {'id':'plt-ja','title':'PLT日本語原本','reason':'公式PDFの直接取得が403のため未収録。現行WIPO英語原本を収録。','sourceUrl':'https://www.mofa.go.jp/mofaj/files/000070118.pdf'},
 {'id':'berne-ja','title':'ベルヌ条約日本語原本','reason':'公式スキャンPDFの直接取得及び信頼できる全文抽出ができず未収録。現行WIPO英語原本を収録。','sourceUrl':'https://www.mofa.go.jp/mofaj/gaiko/treaty/pdfs/B-S50-0113_1.pdf'}]}
report=[]

def add_files(meta, json_path):
    for filename,mime in [(meta['file'],meta['mimeType']),(json_path.name,'application/json')]:
        p=OUT/filename
        manifest['files'].append({'path':filename,'bytes':p.stat().st_size,'mimeType':mime,'sha256':sha(p)})
    meta['bytes']=(OUT/meta['file']).stat().st_size
    meta['textFile']=json_path.name
    meta['textBytes']=json_path.stat().st_size
    meta['verifiedAt']=VERIFIED
    manifest['treaties'].append(meta)

for info in PDFS:
    source=RAW/(info['id']+'.pdf')
    if not source.exists(): raise RuntimeError(f'Missing verified PDF: {source}')
    assert source.read_bytes().startswith(b'%PDF-'),str(source)
    dest=OUT/source.name
    shutil.copyfile(source,dest)
    result=subprocess.run(['pdftotext','-layout',str(source),'-'],check=True,capture_output=True)
    text=result.stdout.decode('utf-8')
    pages=text.split('\f')
    if pages[-1]=='':pages.pop()
    page_count=len(PdfReader(source).pages)
    assert len(pages)==page_count,(source,len(pages),page_count)
    arts=[]
    empty=[]
    for i,page in enumerate(pages,1):
        value='\n'.join(clean_line(x)for x in page.splitlines()).strip()
        if not value:empty.append(i)
        arts.append(article(f'page-{i}',f'本文 p.{i}',value,section='条約・関連文書',page=i,originalUrl=f'{dest.name}#page={i}'))
    data={**info,'verifiedAt':VERIFIED,'originalFile':dest.name,'extractionMethod':'Poppler pdftotext -layout; full document split by physical PDF page','extractionNote':'PDFの表示上のページ単位で抽出した本文です。表紙、目次、説明注、空白ページを含みます。条番号単位の分割ではありません。表の配置・脚注・字体は収録PDFで確認できます。','pageCount':page_count,'articles':arts,'appendices':[]}
    jp=OUT/(info['id']+'.json');save_json(jp,data)
    meta={**info,'file':dest.name,'mimeType':'application/pdf','originalKind':'official-pdf','sectionCount':len(arts),'sectionUnit':'page','pageCount':page_count,'emptyPageCount':len(empty),'attribution':'World Intellectual Property Organization (WIPO)'}
    add_files(meta,jp)
    report.append({'id':info['id'],'pages':page_count,'emptyPages':empty,'extractedCharacters':sum(len(a['text'])for a in arts),'pdfSha256':sha(dest)})

heading=re.compile(r'^(?:#+\s*)?(第[一二三四五六七八九十百〇0-9０-９]+(?:条|規則)(?:の[一二三四五六七八九十百〇0-9０-９]+)*)(?=$|[\s\u3000])(.*)$')
japanese=re.compile(r'[\u3040-\u30ff\u3400-\u9fff]')
for info in HTMLS:
    raw=json.loads((RAW/(info['id']+'-web-extract.json')).read_text())
    assert len(raw['lines'])==raw['total']
    all_lines=[raw['lines'][str(i)]for i in range(raw['total'])]
    if info['id']=='trips':
        begin=29;end=next(i for i,s in enumerate(all_lines)if s.strip()=='* * *')
    else:
        begin=8;end=next(i for i,s in enumerate(all_lines)if '†法的事項】'in s)
    body=all_lines[begin:end]
    original_text='\n'.join(body)
    note='公式ページから取得した本文テキストの保存版です。元のHTMLファイルそのものではありません。外国語対訳を含め、掲載本文の取得行を順序どおり保存しています。画像・元の組版・外部様式は含みません。'
    html_name=info['id']+'-source-text.html'
    src=html.escape(raw['url'],quote=True)
    output='<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+html.escape(info['title'])+'</title><style>body{max-width:58rem;margin:2rem auto;padding:0 1rem;font-family:system-ui,sans-serif;line-height:1.8;color:#17251f}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.note{padding:1rem;background:#eef3ee;border-radius:.6rem}</style><h1>'+html.escape(info['title'])+'</h1><p class="note">'+html.escape(info['editionNote'])+'</p><p>'+html.escape(note)+'</p><p>出典：<a href="'+src+'">外務省公式掲載ページ</a>　取得確認日：'+VERIFIED+'</p><pre>'+html.escape(original_text)+'</pre></html>'
    (OUT/html_name).write_text(output,encoding='utf-8')
    jp_lines=[]
    for line in body:
        value=clean_line(line)
        if not value or not japanese.search(value):continue
        value=re.sub(r'^#+\s*','',value)
        # Original MOFA heading omits a space in this one place. Add a parse
        # boundary only; do not alter the saved source text or the provision.
        if info['id']=='tlt'and value.startswith('第三規則出願'):
            value=value.replace('第三規則','第三規則 ',1)
        jp_lines.append(value)
    arts=[];apps=[];current=None;aux=[]
    appendix_mode=False;section='条約'
    def flush_aux():
        if aux:apps.append({'title':'前文・補足'if not arts else '補足・附属文書','text':'\n'.join(aux)});aux.clear()
    for line in jp_lines:
        if line=='附属書' and info['id']=='trips':
            appendix_mode=True;current=None;flush_aux();aux.append(line);continue
        if appendix_mode:aux.append(line);continue
        if line=='商標法条約に基づく規則':
            section='規則';current=None;flush_aux();aux.append(line);continue
        m=heading.match(line)
        if m:
            flush_aux()
            current=article(f'article-{len(arts)+1}',m.group(1),'',m.group(2).strip(),section)
            arts.append(current)
        elif current is not None:
            current['paragraphs'].append({'number':'','text':line})
        else:aux.append(line)
    flush_aux()
    for a in arts:a['text']='\n'.join(p['text']for p in a['paragraphs'])
    assert len(arts)==info['expectedArticles'],(info['id'],len(arts),info['expectedArticles'])
    assert all(a['text']for a in arts),info['id']
    data={**{k:v for k,v in info.items()if k!='expectedArticles'},'language':'ja','sourceUrl':raw['url'],'verifiedAt':VERIFIED,'originalFile':html_name,'extractionMethod':'Complete official web text extraction; Japanese paragraphs; article heading segmentation','extractionNote':note+' 読み上げ用本文は日本語段落を抽出しています。項号の記号やリスト階層は抽出形式です。','articles':arts,'appendices':apps}
    jp=OUT/(info['id']+'.json');save_json(jp,data)
    meta={**{k:v for k,v in info.items()if k!='expectedArticles'},'language':'ja','sourceUrl':raw['url'],'file':html_name,'mimeType':'text/html','originalKind':'official-html-text-extract','sectionCount':len(arts),'sectionUnit':'article','appendixCount':len(apps),'attribution':'外務省掲載本文を抽出・整形','extractionNote':note}
    add_files(meta,jp)
    report.append({'id':info['id'],'sourceLines':raw['total'],'capturedLines':len(raw['lines']),'sourceBodyRange':[begin,end-1],'articles':len(arts),'appendices':len(apps),'japaneseCharacters':sum(len(a['text'])for a in arts)+sum(len(a['text'])for a in apps)})

manifest['treatyCount']=len(manifest['treaties'])
manifest['totalBytes']=sum(f['bytes']for f in manifest['files'])
manifest['historicalCount']=sum(t['status']=='historical'for t in manifest['treaties'])
manifest['englishCount']=sum(t['language']=='en'for t in manifest['treaties'])
manifest['japaneseCount']=sum(t['language']=='ja'for t in manifest['treaties'])
save_json(OUT/'manifest.json',manifest)
save_json(args.report,{'verifiedAt':VERIFIED,'documents':report,'allExpectedArticleCountsMatch':True,'allPublicFilesPresent':all((OUT/f['path']).exists()for f in manifest['files'])})
print(json.dumps({'treaties':manifest['treatyCount'],'files':len(manifest['files']),'totalBytes':manifest['totalBytes'],'historicalCount':manifest['historicalCount'],'sections':sum(t['sectionCount']for t in manifest['treaties'])},ensure_ascii=False))

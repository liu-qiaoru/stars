/**
 * 为缺少人工标签的冻结候选生成本地盲评页。生产库只读；复用有效Worker拼图，
 * 或用现有Worker代码在本地生成。零模型调用，不把画面描述当标签；页面无外部请求。
 */
import { loadEnvFile } from 'node:process'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { buildLocalReviewEvidence } from './retrieval-review-evidence.js'
import { Pool } from 'pg'
import { createSettings } from '../src/config/settings.js'
loadEnvFile('../../.env')
const root = '../../.scratch/retrieval-quality'
const settings = createSettings(process.env)
const pool = new Pool({ connectionString: settings.databaseUrl, options: '-c default_transaction_read_only=on' })
const snapshot = JSON.parse(await readFile(`${root}/frozen.json`, 'utf8'))
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
const review: any[] = []
try {
  await mkdir(`${root}/review-images`, { recursive: true })
  for (const testCase of snapshot.cases.filter((item: any) => item.id !== 'empty')) {
    for (const [index, result] of testCase.results.entries()) {
      const key = result.scene_id ? `video:${result.scene_id}` : `image:${result.asset_id}`
      // 用户已确认已有标签来自人工；只补当前版本仍缺失或存在冲突的身份。
      const generation = (await pool.query('select index_generation from media_files where id=$1 and deleted_at is null', [result.file_id])).rows[0]?.index_generation
      const known = testCase.reusable_labels.filter((label: any) => label.file_id === result.file_id && label.file_generation === generation &&
        (result.scene_id ? label.scene_id === result.scene_id : label.candidate_key === result.asset_id))
      if (new Set(known.map((label: any) => label.relevance)).size === 1) continue
      let artifact: string | null = null
      if (result.scene_id) {
        const evidence = (await pool.query(`select e.artifact_path, e.artifact_sha256 from candidate_evidence e
          join media_files f on f.id=e.file_id and f.index_generation=e.file_generation
          where e.file_id=$1 and e.scene_id=$2 and e.asset_id=$3 and e.status='succeeded'
          and e.strategy='contact_sheet_v1' and f.deleted_at is null order by e.created_at desc limit 1`,
          [result.file_id, result.scene_id, result.asset_id])).rows[0]
        if (evidence) {
          const bytes = await readFile(evidence.artifact_path)
          if (createHash('sha256').update(bytes).digest('hex') !== evidence.artifact_sha256) throw new Error('Review artifact changed')
          artifact = `review-images/${testCase.id}-${index + 1}.png`
          await writeFile(`${root}/${artifact}`, bytes)
        } else {
          const asset = (await pool.query('select asset_type from media_assets where id=$1', [result.asset_id])).rows[0]
          const anchor = asset.asset_type === 'video_frame' ? result.asset_id : (await pool.query(`select ma.id from media_assets ma
            join vector_refs vr on vr.asset_id=ma.id where ma.scene_id=$1 and ma.file_id=$2 and ma.asset_type='video_frame'
            and vr.collection_name='video_frame_vectors' and vr.status='indexed' and coalesce(ma.metadata_json->>'stale','false')!='true'
            order by ma.frame_time_seconds, ma.id limit 1`, [result.scene_id, result.file_id])).rows[0]?.id
          const generated = await buildLocalReviewEvidence(pool, { fileId: result.file_id, sceneId: result.scene_id, assetId: anchor, candidateKey: key })
          artifact = generated.image
        }
      } else {
        artifact = `review-images/${testCase.id}-${index + 1}.jpg`
        await copyFile(result.path, `${root}/${artifact}`)
      }
      review.push({ id: `${testCase.id}-${index + 1}`, case_id: testCase.id, query: testCase.query,
        candidate_key: key, start_seconds: result.start_time_seconds, end_seconds: result.end_time_seconds,
        image: artifact, relevance: null })
    }
  }
  await writeFile(`${root}/human-label-template.json`, JSON.stringify({ fingerprint: snapshot.fingerprint,
    source: 'human_review_required', labels: review.map(({ image, ...row }) => row) }, null, 2))
  const cards = review.map(row => `<article><h2>${escape(row.id)} · ${escape(row.query)}</h2>
    <p>场景 ${row.start_seconds ?? '—'} 至 ${row.end_seconds ?? '—'} 秒。只按用户全部条件判断；拼图无法确定时选“无法判断”。</p>
    ${row.image ? `<img src="${escape(row.image)}" alt="${escape(row.id)} 场景拼图">` : '<p>当前没有可读拼图，请保留无法判断。</p>'}
    <label>人工相关等级 <select data-id="${escape(row.id)}"><option value="">未标注</option><option value="2">2 完全符合</option><option value="1">1 部分相关</option><option value="0">0 不相关</option><option value="unknown">无法判断</option></select></label></article>`).join('\n')
  await writeFile(`${root}/human-review.html`, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>冻结素材人工核验</title>
    <style>body{font:16px system-ui;margin:24px;max-width:1200px}article{border-top:1px solid #ccc;padding:20px 0}img{max-width:100%;max-height:600px}select,button{font:inherit;padding:8px}textarea{width:100%;height:180px}</style>
    <h1>人工核验：冻结查询集缺失标签</h1><p>这是本地页面，零外发。已复用你确认过的26个有效人工标签，仅展示缺失标签。没有展示模型判断或排序分数。2=全部条件符合；1=只符合部分条件（计算前五相关比例时计为相关）；0=不相关；无法判断保持空值，不能按0填充。连续动作必须检查原片，拼图不证明动作连续。请逐条选择后复制下方JSON。</p>
    <button id="export">生成人工标签</button><textarea id="output" aria-label="人工标签JSON"></textarea>${cards}
    <script>const rows=${JSON.stringify(review.map(({ image, ...row }) => row)).replace(/</g, '\\u003c')};
      document.querySelector('#export').onclick=()=>{for(const row of rows){const value=document.querySelector('[data-id="'+row.id+'"]').value;row.relevance=value===''||value==='unknown'?null:Number(value)}document.querySelector('#output').value=JSON.stringify({fingerprint:${JSON.stringify(snapshot.fingerprint)},source:'human_review',labels:rows},null,2);window.scrollTo(0,0)};</script></html>`)
  console.log(JSON.stringify({ review_candidates: review.length, images_available: review.filter(row => row.image).length, external_calls: 0 }))
} finally { await pool.end() }

/**
 * LIXIL 栗沢工場 APMシステム - 粉砕・ペレタイザー実績API (Api_InputScrap.gs)
 * [粉砕実績単体・検証解決仕様 - 本物のgoogle.script.run絶対防衛版]
 */

/**
 * 1. 粉砕・ペレタイザー実績の取得 (特定の日付・直)
 * 💡 登録用のlixil-workspace内で単一テーブルから読み込みます。
 */
function getPelletData(date, shift) {
  const projectId = 'lixil-workspace';
  const datasetId = 'an1_kurisawa_oshidashi';
  const sql = `SELECT * FROM \`${projectId}.${datasetId}.input_scrap_pellet\` WHERE work_date = '${date}' AND shift = '${shift}' LIMIT 1`;
  try { return runBigQueryQuery_(sql, projectId)[0] || null; } catch (e) { console.error('getPelletData Error:', e); throw e; }
}

/**
 * 2. 粉砕・ペレタイザー実績の保存 (MERGEによる登録・更新)
 * 💡 登録用のlixil-workspace内で保存します。
 */
function savePelletData(data) {
  const projectId = 'lixil-workspace';
  const datasetId = 'an1_kurisawa_oshidashi';
  const sql = `MERGE \`${projectId}.${datasetId}.input_scrap_pellet\` T USING (SELECT DATE('${data.work_date}') as d, '${data.shift}' as s, ${data.white_scrap_weight} as ww, ${data.white_scrap_time} as wt, ${data.color_scrap_weight} as cw, ${data.color_scrap_time} as ct, ${data.pellet_weight} as pw, ${data.pellet_time} as ptm, '${data.pellet_type}' as pt) S ON T.work_date = S.d AND T.shift = S.s WHEN MATCHED THEN UPDATE SET white_scrap_weight = S.ww, white_scrap_time = S.wt, color_scrap_weight = S.cw, color_scrap_time = S.ct, pellet_weight = S.pw, pellet_time = S.ptm, pellet_type = S.pt, updated_at = CURRENT_TIMESTAMP() WHEN NOT MATCHED THEN INSERT (work_date, shift, white_scrap_weight, white_scrap_time, color_scrap_weight, color_scrap_time, pellet_weight, pellet_time, pellet_type, updated_at) VALUES (S.d, S.s, S.ww, S.wt, S.cw, S.ct, S.pw, S.ptm, S.pt, CURRENT_TIMESTAMP())`;
  try { runBigQueryQuery_(sql, projectId); return { status: 'success' }; } catch (e) { console.error('savePelletData Error:', e); throw e; }
}

/**
 * 3. 分析用データの取得 (【検証解決版】)
 * 💡 最も実績のある極めてシンプルな初期の形式にSQLを回帰。
 * 判定ズレを引き起こすDATE関数を介さず、文字列によるクリーンなBETWEEN抽出を行います。
 */
function getPelletAnalysisData(start, end) {
  const projectIdWork = 'lixil-workspace';
  const datasetIdWork = 'an1_kurisawa_oshidashi';
  
  const sql = `
    SELECT 
      work_date,
      shift,
      COALESCE(white_scrap_weight, 0.0) AS white_scrap_weight,
      COALESCE(white_scrap_time, 0) AS white_scrap_time,
      COALESCE(color_scrap_weight, 0.0) AS color_scrap_weight,
      COALESCE(color_scrap_time, 0) AS color_scrap_time,
      COALESCE(pellet_weight, 0.0) AS pellet_weight,
      COALESCE(pellet_time, 0) AS pellet_time,
      COALESCE(pellet_type, '') AS pellet_type,
      0.0 AS defect_failure_weight
    FROM \`${projectIdWork}.${datasetIdWork}.input_scrap_pellet\`
    WHERE work_date BETWEEN '${start}' AND '${end}'
    ORDER BY work_date DESC, shift ASC
  `;
  
  try {
    console.log(`[LDP粉砕データ一括取得]: ${start} ~ ${end}`);
    return runBigQueryQuery_(sql, projectIdWork);
  } catch (e) {
    console.error('getPelletAnalysisData Fatal Error:', e);
    throw e;
  }
}

/**
 * BigQuery実行共通関数 (内部用)
 */
function runBigQueryQuery_(sql, projectId) {
  const request = { query: sql, useLegacySql: false, location: 'asia-northeast1' };
  let results = BigQuery.Jobs.query(request, projectId);
  let jobId = results.jobReference.jobId;
  while (!results.jobComplete) {
    Utilities.sleep(500);
    results = BigQuery.Jobs.getQueryResults(projectId, jobId, { location: 'asia-northeast1' });
  }
  if (!results.rows) return [];
  const fields = results.schema.fields;
  return results.rows.map(row => {
    const obj = {};
    row.f.forEach((cell, i) => {
      let val = cell.v;
      if (fields[i].type === 'FLOAT' || fields[i].type === 'INTEGER') val = Number(val);
      obj[fields[i].name] = val;
    });
    return obj;
  });
}
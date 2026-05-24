/**
 * LIXIL 栗沢工場 APMシステム - 粉砕・ペレタイザー実績API (Api_InputScrap.gs)
 * [粉砕実績単体・安全防衛・構文エラー絶対回避版]
 */

// グローバル定数。他画面と絶対に衝突しないユニークなプレフィックスを付与
const SCRAP_PROJECT_ID = 'lixil-workspace';
const SCRAP_DATASET_ID = 'an1_kurisawa_oshidashi';
const SCRAP_LOCATION = 'asia-northeast1';

/**
 * 1. 粉砕・ペレタイザー実績の取得 (特定の日付・直)
 */
function getPelletData(date, shift) {
  // 構文解析エラーを避けるため、テンプレートリテラルのネストを廃止し、安全な文字列結合を使用します
  const sql = "SELECT * FROM `" + SCRAP_PROJECT_ID + "." + SCRAP_DATASET_ID + ".input_scrap_pellet` WHERE work_date = '" + date + "' AND shift = '" + shift + "' LIMIT 1";
  try { 
    const res = runBigQueryQuerySafe_(sql, SCRAP_PROJECT_ID);
    return res[0] || null; 
  } catch (e) { 
    console.error('getPelletData Error:', e); 
    throw new Error('粉砕データの取得に失敗しました: ' + e.toString()); 
  }
}

/**
 * 2. 粉砕・ペレタイザー実績の保存 (MERGEによる登録・更新)
 */
function savePelletData(data) {
  // バッククォートのエスケープエラーを回避する、クリーンな文字列ビルド
  const tablePath = SCRAP_PROJECT_ID + "." + SCRAP_DATASET_ID + ".input_scrap_pellet";
  const sql = "MERGE `" + tablePath + "` T USING (" +
              "SELECT DATE('" + data.work_date + "') as d, " +
              "'" + data.shift + "' as s, " +
              (data.white_scrap_weight !== null ? data.white_scrap_weight : "NULL") + " as ww, " +
              (data.white_scrap_time !== null ? data.white_scrap_time : "NULL") + " as wt, " +
              (data.color_scrap_weight !== null ? data.color_scrap_weight : "NULL") + " as cw, " +
              (data.color_scrap_time !== null ? data.color_scrap_time : "NULL") + " as ct, " +
              (data.pellet_weight !== null ? data.pellet_weight : "NULL") + " as pw, " +
              (data.pellet_time !== null ? data.pellet_time : "NULL") + " as ptm, " +
              "'" + (data.pellet_type || "") + "' as pt" +
              ") S ON T.work_date = S.d AND T.shift = S.s " +
              "WHEN MATCHED THEN UPDATE SET " +
              "white_scrap_weight = S.ww, " +
              "white_scrap_time = S.wt, " +
              "color_scrap_weight = S.cw, " +
              "color_scrap_time = S.ct, " +
              "pellet_weight = S.pw, " +
              "pellet_time = S.ptm, " +
              "pellet_type = S.pt, " +
              "updated_at = CURRENT_TIMESTAMP() " +
              "WHEN NOT MATCHED THEN INSERT " +
              "(work_date, shift, white_scrap_weight, white_scrap_time, color_scrap_weight, color_scrap_time, pellet_weight, pellet_time, pellet_type, updated_at) " +
              "VALUES (S.d, S.s, S.ww, S.wt, S.cw, S.ct, S.pw, S.ptm, S.pt, CURRENT_TIMESTAMP())";

  try { 
    runBigQueryQuerySafe_(sql, SCRAP_PROJECT_ID); 
    return { status: 'success' }; 
  } catch (e) { 
    console.error('savePelletData Error:', e); 
    throw new Error('粉砕データの保存に失敗しました: ' + e.toString()); 
  }
}

/**
 * 3. 分析用データの取得
 */
function getPelletAnalysisData(start, end) {
  const tablePath = SCRAP_PROJECT_ID + "." + SCRAP_DATASET_ID + ".input_scrap_pellet";
  const sql = "SELECT " +
              "work_date, " +
              "shift, " +
              "COALESCE(white_scrap_weight, 0.0) AS white_scrap_weight, " +
              "COALESCE(white_scrap_time, 0) AS white_scrap_time, " +
              "COALESCE(color_scrap_weight, 0.0) AS color_scrap_weight, " +
              "COALESCE(color_scrap_time, 0) AS color_scrap_time, " +
              "COALESCE(pellet_weight, 0.0) AS pellet_weight, " +
              "COALESCE(pellet_time, 0) AS pellet_time, " +
              "COALESCE(pellet_type, '') AS pellet_type, " +
              "0.0 AS defect_failure_weight " +
              "FROM `" + tablePath + "` " +
              "WHERE work_date BETWEEN '" + start + "' AND '" + end + "' " +
              "ORDER BY work_date DESC, shift ASC";
  
  try {
    console.log("[LDP粉砕データ一括取得]: " + start + " ~ " + end);
    return runBigQueryQuerySafe_(sql, SCRAP_PROJECT_ID);
  } catch (e) {
    console.error('getPelletAnalysisData Fatal Error:', e);
    throw new Error('分析データの取得に失敗しました: ' + e.toString());
  }
}

/**
 * 💡 新設：分析用データ取得のポータル連携用ゲートウェイAPI
 * これにより、Api_analysisscrap.gs などの余計なファイルを増やすことなく、
 * スクリップエラーや競合リスクをさらにゼロに抑え込みます。
 */
function getScrapAnalysisData(start, end) {
  return getPelletAnalysisData(start, end);
}

/**
 * 💡 内部用：BigQuery実行共通関数 (無限ループ完全排除・安全タイムアウト監視仕様)
 */
function runBigQueryQuerySafe_(sql, projectId) {
  const jobConfig = { 
    configuration: { 
      query: { 
        query: sql, 
        useLegacySql: false 
      } 
    } 
  };
  const options = { location: SCRAP_LOCATION };
  
  try {
    const jobResult = BigQuery.Jobs.insert(jobConfig, projectId);
    const jobId = jobResult.jobReference.jobId;
    
    // 安全カウンタ：最大15回ループ(計7.5秒)で必ずタイムアウトさせて無限ループを完全に防止
    let loopCounter = 0;
    const maxLoops = 15; 
    
    while (loopCounter < maxLoops) {
      const currentJob = BigQuery.Jobs.get(projectId, jobId, options);
      if (currentJob.status && currentJob.status.state === 'DONE') {
        if (currentJob.status.errorResult) {
          throw new Error("BigQuery実行エラー: " + currentJob.status.errorResult.message);
        }
        break;
      }
      Utilities.sleep(500);
      loopCounter++;
    }
    
    if (loopCounter >= maxLoops) {
      throw new Error("BigQueryクエリ処理がタイムアウトしました。ジョブの状態を確認してください。");
    }
    
    const queryResults = BigQuery.Jobs.getQueryResults(projectId, jobId, options);
    if (!queryResults.rows) return [];
    
    const fields = queryResults.schema.fields;
    return queryResults.rows.map(row => {
      const obj = {};
      row.f.forEach((cell, i) => {
        let val = cell.v;
        const type = fields[i].type;
        if (type === 'FLOAT' || type === 'INTEGER') {
          val = val !== null ? Number(val) : null;
        }
        obj[fields[i].name] = val;
      });
      return obj;
    });
  } catch (e) {
    console.error('runBigQueryQuerySafe_ Error:', e.toString());
    throw e;
  }
}
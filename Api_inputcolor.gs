/**
 * 色調実績の取得
 * 1. 現在の直の入力済みデータ
 * 2. 当日以前で最も新しい「1直」の管理限界値（引き継ぎ機能）
 */
function getColorRecords(date, shift) {
  const projectId = 'lixil-workspace';
  const datasetId = 'an1_kurisawa_oshidashi';
  const tableId = 'input_colorTR';

  // 【機能維持：管理限界値の取得】
  // 指定された日付以前で、最新の「1直」のデータを1件だけ取得します
  // これにより、当日1直が未入力でも、前回の設定値を自動で表示できます
  const limitQuery = `
    SELECT UpperLimit, LowerLimit, EXTDate
    FROM \`${projectId}.${datasetId}.${tableId}\`
    WHERE EXTShift = 1 AND EXTDate <= '${date}' AND UpperLimit IS NOT NULL
    ORDER BY EXTDate DESC, Timestamp DESC
    LIMIT 1
  `;

  // 【機能維持：実績データの取得】
  // 同一時間・同一直に複数データがある場合、最新のTimestampのみを採用します
  const dataQuery = `
    SELECT * FROM \`${projectId}.${datasetId}.${tableId}\`
    WHERE EXTDate = '${date}' AND EXTShift = ${shift}
    QUALIFY ROW_NUMBER() OVER(PARTITION BY EXTDate, EXTShift, EXTTime ORDER BY Timestamp DESC) = 1
    ORDER BY EXTTime
  `;

  try {
    const limitsResult = BigQuery.Jobs.query({ query: limitQuery, useLegacySql: false }, projectId);
    const dataResult = BigQuery.Jobs.query({ query: dataQuery, useLegacySql: false }, projectId);

    // 限界値の初期化
    let dayLimits = { upper: null, lower: null, limitDate: null };
    if (limitsResult.rows && limitsResult.rows.length > 0) {
      dayLimits.upper = limitsResult.rows[0].f[0].v;
      dayLimits.lower = limitsResult.rows[0].f[1].v;
      dayLimits.limitDate = limitsResult.rows[0].f[2].v;
    }

    // 実績データのパース
    let records = [];
    if (dataResult.rows) {
      const headers = dataResult.schema.fields.map(f => f.name);
      records = dataResult.rows.map(row => {
        const obj = {};
        row.f.forEach((cell, i) => { 
          obj[headers[i]] = (cell.v === null) ? null : cell.v; 
        });
        return obj;
      });
    }

    return { records: records, dayLimits: dayLimits };
  } catch (e) {
    console.error("getColorRecords Error:", e);
    throw new Error("LDPからのデータ取得に失敗しました: " + e.toString());
  }
}

/**
 * 実績の保存（BigQueryへのインサート）
 * 空欄(null)を許容し、最新のTimestampを付与して保存します
 */
function saveColorRecords(records) {
  const projectId = 'lixil-workspace';
  const datasetId = 'an1_kurisawa_oshidashi';
  const tableId = 'input_colorTR';

  if (!records || records.length === 0) return { success: false, error: "保存するデータがありません" };
  
  const timestamp = new Date().toISOString();
  
  // BigQueryへ送る行データの作成
  const rows = records.map(r => ({
    json: { 
      ...r, 
      Timestamp: timestamp,
      // 文字列として扱われるのを防ぐため、明示的に数値型へ変換（nullはそのまま）
      UpperLimit: r.UpperLimit !== null ? parseFloat(r.UpperLimit) : null,
      LowerLimit: r.LowerLimit !== null ? parseFloat(r.LowerLimit) : null,
      Temp: r.Temp !== null ? parseFloat(r.Temp) : null,
      Humid: r.Humid !== null ? parseFloat(r.Humid) : null
    }
  }));

  try {
    // ストリーミング・インサート
    const response = BigQuery.Tabledata.insertAll({ rows: rows }, projectId, datasetId, tableId);
    
    if (response.insertErrors && response.insertErrors.length > 0) {
      console.error("BigQuery Insert Errors:", response.insertErrors);
      return { success: false, error: "一部のデータ保存に失敗しました" };
    }
    
    return { success: true };
  } catch (e) {
    console.error("saveColorRecords Error:", e);
    return { success: false, error: "データベース接続エラー: " + e.toString() };
  }
}
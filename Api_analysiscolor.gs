/**
 * 指定期間の色調分析データを取得
 */
function getColorAnalysisData(startDate, endDate, machineId) {
  const projectId = 'lixil-workspace';
  const datasetId = 'an1_kurisawa_oshidashi';
  const tableId = 'input_colorTR';

  // 号機IDをカラム名に変換 (例: 1号機 -> M1)
  const colName = "M" + machineId.replace('号機', '');

  // 期間内の最新レコードを取得
  // 日付、時間、直の順でソート
  const query = `
    SELECT 
      EXTDate, 
      EXTShift, 
      EXTTime, 
      Temp, 
      Humid, 
      UpperLimit, 
      LowerLimit, 
      ${colName} AS ActualValue
    FROM \`${projectId}.${datasetId}.${tableId}\`
    WHERE EXTDate BETWEEN '${startDate}' AND '${endDate}'
    QUALIFY ROW_NUMBER() OVER(PARTITION BY EXTDate, EXTShift, EXTTime ORDER BY Timestamp DESC) = 1
    ORDER BY EXTDate ASC, EXTTime ASC
  `;

  try {
    const results = BigQuery.Jobs.query({
      query: query,
      useLegacySql: false
    }, projectId);

    if (!results.rows) return [];

    const headers = results.schema.fields.map(f => f.name);
    return results.rows.map(row => {
      const obj = {};
      row.f.forEach((cell, i) => {
        obj[headers[i]] = cell.v;
      });
      return obj;
    });
  } catch (e) {
    console.error(e);
    throw new Error("分析データの取得に失敗しました: " + e.toString());
  }
}
/**
 * マーキング本数実績に関連するBigQuery操作
 */

const MARKING_BQ_CONFIG = {
  DWH_PROJECT: 'lixil-dwh',
  WORKSPACE_PROJECT: 'lixil-workspace',
  DATASET_DWH: 'pii_an1_j_tie_up_kurisawa',
  DATASET_WORKSPACE: 'an1_kurisawa_oshidashi',
  TABLE_EXT_RESULT: 'EXTResultTR',
  TABLE_STOCK_IN_OUT: 'StockInOutTR',
  TABLE_INPUT_MARKING: 'input_markingTR'
};

/**
 * テーブルの存在とスキーマを確認し、必要であれば作成する内部関数
 */
function _ensureTableExists() {
  const projectId = MARKING_BQ_CONFIG.WORKSPACE_PROJECT;
  const datasetId = MARKING_BQ_CONFIG.DATASET_WORKSPACE;
  const tableId = MARKING_BQ_CONFIG.TABLE_INPUT_MARKING;

  try {
    BigQuery.Tables.get(projectId, datasetId, tableId);
  } catch (e) {
    const schema = {
      fields: [
        { name: 'EXTDate', type: 'STRING', mode: 'REQUIRED' },
        { name: 'EXTShift', type: 'INTEGER', mode: 'REQUIRED' },
        { name: 'Kataban', type: 'STRING', mode: 'REQUIRED' },
        { name: 'ContainerNo', type: 'STRING', mode: 'REQUIRED' },
        { name: 'MarkingCount', type: 'INTEGER', mode: 'NULLABLE' },
        { name: 'Timestamp', type: 'TIMESTAMP', mode: 'NULLABLE' }
      ]
    };

    const table = {
      tableReference: {
        projectId: projectId,
        datasetId: datasetId,
        tableId: tableId
      },
      schema: schema
    };

    BigQuery.Tables.insert(table, projectId, datasetId);
  }
}

/**
 * 指定された日付と直の容器リストを取得する（入力画面用）
 */
function getMarkingContainerList(targetDate, targetShift) {
  _ensureTableExists();

  const projectId = MARKING_BQ_CONFIG.DWH_PROJECT;
  const dateHyphen = targetDate;
  const dateSlash = targetDate.replace(/-/g, '/');
  const dateNone = targetDate.replace(/-/g, '');
  
  const sql = `
    SELECT 
      E.EXTMachine AS Machine,
      S.Kataban, 
      S.ContainerNo,
      I.MarkingCount AS Count
    FROM \`${MARKING_BQ_CONFIG.DWH_PROJECT}.${MARKING_BQ_CONFIG.DATASET_DWH}.${MARKING_BQ_CONFIG.TABLE_EXT_RESULT}\` AS E
    INNER JOIN \`${MARKING_BQ_CONFIG.DWH_PROJECT}.${MARKING_BQ_CONFIG.DATASET_DWH}.${MARKING_BQ_CONFIG.TABLE_STOCK_IN_OUT}\` AS S
      ON CAST(E.EXTLotNo AS STRING) = CAST(S.STLotNo AS STRING)
      AND E.EXTLotNo IS NOT NULL 
    LEFT JOIN (
      -- 最新のレコードのみを抽出（0本も含めて抽出する）
      SELECT * EXCEPT(rn)
      FROM (
        SELECT *, ROW_NUMBER() OVER(PARTITION BY EXTDate, EXTShift, Kataban, ContainerNo ORDER BY Timestamp DESC) as rn
        FROM \`${MARKING_BQ_CONFIG.WORKSPACE_PROJECT}.${MARKING_BQ_CONFIG.DATASET_WORKSPACE}.${MARKING_BQ_CONFIG.TABLE_INPUT_MARKING}\`
      )
      WHERE rn = 1
    ) AS I
      ON I.EXTDate = '${dateHyphen}' 
      AND I.EXTShift = ${parseInt(targetShift, 10)}
      AND S.Kataban = I.Kataban 
      AND S.ContainerNo = I.ContainerNo
    WHERE E.EXTDate IN ('${dateHyphen}', '${dateSlash}', '${dateNone}') 
      AND CAST(E.EXTShift AS STRING) = '${targetShift}'
    ORDER BY E.EXTMachine ASC, S.ContainerNo ASC
    LIMIT 1000
  `;

  try {
    const queryResults = BigQuery.Jobs.query({ query: sql, useLegacySql: false }, projectId);
    const rows = queryResults.rows;
    if (!rows) return [];

    return rows.map(row => ({
      Machine: row.f[0].v,
      Kataban: row.f[1].v,
      ContainerNo: row.f[2].v,
      Count: row.f[3].v ? parseInt(row.f[3].v, 10) : null
    }));
  } catch (e) {
    throw new Error('データ取得に失敗しました: ' + e.toString());
  }
}

/**
 * 実績データを保存・更新する
 */
function saveMarkingDataToBQ(payload) {
  if (!payload || payload.length === 0) return;
  _ensureTableExists();

  const projectId = MARKING_BQ_CONFIG.WORKSPACE_PROJECT;
  const datasetId = MARKING_BQ_CONFIG.DATASET_WORKSPACE;
  const tableId = MARKING_BQ_CONFIG.TABLE_INPUT_MARKING;
  
  const targetDate = payload[0].date;
  const targetShift = payload[0].shift;

  try {
    const deleteSql = `
      DELETE FROM \`${projectId}.${datasetId}.${tableId}\`
      WHERE EXTDate = '${targetDate}' AND EXTShift = ${parseInt(targetShift, 10)}
    `;
    BigQuery.Jobs.query({ query: deleteSql, useLegacySql: false }, projectId);

    const insertRows = payload.map(item => ({
      json: {
        EXTDate: item.date,
        EXTShift: parseInt(item.shift, 10),
        Kataban: item.kataban,
        ContainerNo: item.containerNo,
        MarkingCount: parseInt(item.count, 10),
        Timestamp: new Date().toISOString()
      }
    }));

    const response = BigQuery.Tabledata.insertAll({ rows: insertRows }, projectId, datasetId, tableId);
    if (response.insertErrors) throw new Error('挿入中にエラーが発生しました');

    return { success: true };
  } catch (e) {
    throw new Error('保存処理に失敗しました: ' + e.toString());
  }
}

/**
 * 分析機能用関数
 * 最新の状態が「1本以上」のデータのみを表示します。
 */
function getMarkingAnalysisData(monthStr) {
  _ensureTableExists();
  const projectId = MARKING_BQ_CONFIG.WORKSPACE_PROJECT;
  
  const parts = monthStr.split('-');
  const targetYear = parseInt(parts[0], 10);
  const targetMonth = parseInt(parts[1], 10);

  const sql = `
    SELECT * FROM (
      -- まず日付範囲内で最新の1件を特定する（0本かどうかにかかわらず）
      SELECT 
        EXTDate,
        Kataban,
        ContainerNo,
        MarkingCount AS Count,
        ROW_NUMBER() OVER(
          PARTITION BY EXTDate, EXTShift, Kataban, ContainerNo 
          ORDER BY Timestamp DESC
        ) as rn
      FROM \`${MARKING_BQ_CONFIG.WORKSPACE_PROJECT}.${MARKING_BQ_CONFIG.DATASET_WORKSPACE}.${MARKING_BQ_CONFIG.TABLE_INPUT_MARKING}\`
      WHERE (
        EXTRACT(YEAR FROM SAFE.PARSE_DATE('%Y-%m-%d', EXTDate)) = ${targetYear} OR
        EXTRACT(YEAR FROM SAFE.PARSE_DATE('%Y/%m/%d', EXTDate)) = ${targetYear} OR
        EXTRACT(YEAR FROM SAFE.PARSE_DATE('%Y%m%d', EXTDate)) = ${targetYear}
      )
      AND (
        EXTRACT(MONTH FROM SAFE.PARSE_DATE('%Y-%m-%d', EXTDate)) = ${targetMonth} OR
        EXTRACT(MONTH FROM SAFE.PARSE_DATE('%Y/%m/%d', EXTDate)) = ${targetMonth} OR
        EXTRACT(MONTH FROM SAFE.PARSE_DATE('%Y%m%d', EXTDate)) = ${targetMonth}
      )
    )
    -- 最新の1件を選んだあとに、その値が0より大きいものだけを最終結果とする
    WHERE rn = 1 AND Count >= 1
    ORDER BY EXTDate ASC, ContainerNo ASC
    LIMIT 3000
  `;

  try {
    const queryResults = BigQuery.Jobs.query({ query: sql, useLegacySql: false }, projectId);
    const rows = queryResults.rows;
    if (!rows) return [];

    return rows.map(row => ({
      EXTDate: row.f[0].v,
      Kataban: row.f[1].v,
      ContainerNo: row.f[2].v,
      Count: parseInt(row.f[3].v, 10)
    }));
  } catch (e) {
    throw new Error('分析データの取得失敗: ' + e.toString());
  }
}
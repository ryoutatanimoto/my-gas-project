/**
 * BigQuery/LDP 直結ロジック (旧 gas_code.txt)
 */

const BQ_CONFIG = {
  PROJECT_ID: 'lixil-dwh',
  DATASET_ID: 'pii_an1_j_tie_up_kurisawa',
  LOCATION: 'asia-northeast1'
};

/**
 * 月間データの取得 (フロントエンドから呼び出し)
 */
function getMonthlyData(month) {
  const [year, monthNum] = month.split('-');
  const monthInt = parseInt(monthNum, 10);
  
  const dateFilter = `
    (EXTDate LIKE '${year}/${monthInt}/%' OR EXTDate LIKE '${year}/${monthNum}/%' OR 
     EXTDate LIKE '${year}-${monthInt}-%' OR EXTDate LIKE '${year}-${monthNum}-%')
  `;
  const startDateFilter = dateFilter.replace(/EXTDate/g, 'StartDate');

  const results = {
    month: month,
    oshiji: fetchProductionFromBQ(dateFilter),
    furyouji: fetchDefectsFromBQ(dateFilter),
    jikanji: fetchTimeFromBQ(startDateFilter),
    targets: {},
    prices: {},
    recycleMaster: {}
  };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // マスタデータ取得 (TARGETS, 単価, リサイクル)
  const targetsSheet = ss.getSheetByName("TARGETS");
  if (targetsSheet) {
    const data = targetsSheet.getDataRange().getValues();
    if (data.length > 2) {
      for (let i = 1; i < data[0].length; i++) {
        const mVal = String(data[0][i]).trim();
        if (mVal === month) {
          const machine = String(data[1][i]).trim().toUpperCase();
          const target = parseFloat(data[2][i]);
          results.targets[machine] = target;
        }
      }
    }
  }

  const pricesSheet = ss.getSheetByName("単価マスタ");
  if (pricesSheet) {
    const data = pricesSheet.getDataRange().getValues();
    data.shift();
    data.forEach(r => { if(r[0]) results.prices[String(r[0]).trim().toUpperCase()] = parseFloat(r[1]) || 0; });
  }

  const recycleSheet = ss.getSheetByName("リサイクル型マスタ");
  if (recycleSheet) {
    const data = recycleSheet.getDataRange().getValues();
    data.shift();
    data.forEach(r => { if(r[0]) results.recycleMaster[String(r[0]).trim().toUpperCase().replace(/^0+/, '')] = parseFloat(r[1]) || 0; });
  }

  return results;
}

function fetchProductionFromBQ(dateFilter) {
  const sql = `
    WITH res AS (
      SELECT
        TRIM(EXTLotNo) as EXTLotNo,
        MAX(EXTMachine) as EXTMachine,
        MAX(EXTDate) as EXTDate,
        SUM(GoodQty) as TotalGoodQty,
        MAX(UnitWeight) as UnitWeight,
        MAX(Material) as Material,
        MAX(Kataban) as Kataban,
        MAX(Edaban) as Edaban,
        MAX(RepresentativeLength) as RepresentativeLength,
        MAX(EXTIndicationDate) as EXTIndicationDate,
        MAX(EXTIndicationNo) as EXTIndicationNo
      FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.EXTResultTR\`
      WHERE ${dateFilter}
        AND EXTLotNo IS NOT NULL AND TRIM(EXTLotNo) != ''
      GROUP BY TRIM(EXTLotNo)
    ),
    stock_raw AS (
      SELECT TRIM(STLotNo) as STLotNo, MAX(Color) as Color
      FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.StockInOutTR\`
      GROUP BY TRIM(STLotNo)
    ),
    ind_group_colors AS (
      SELECT 
        r_all.EXTIndicationDate,
        r_all.EXTIndicationNo,
        MAX(s.Color) as GroupColor
      FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.EXTResultTR\` r_all
      JOIN stock_raw s ON TRIM(r_all.EXTLotNo) = s.STLotNo
      WHERE s.Color IS NOT NULL AND s.Color != ''
      GROUP BY 1, 2
    )
    SELECT
      r.EXTMachine AS \`号機\`,
      r.EXTDate AS \`押出日付\`,
      r.Kataban AS \`型番\`,
      IFNULL(SAFE_CAST(r.RepresentativeLength AS FLOAT64), 0) AS \`定尺\`,
      IFNULL(r.UnitWeight, 0) AS \`単重\`,
      IFNULL(r.TotalGoodQty, 0) AS \`積載本数\`,
      COALESCE(s.Color, g.GroupColor, '') AS \`色\`,
      CONCAT(
        TRIM(IFNULL(r.Material, '')),
        SUBSTR(TRIM(COALESCE(s.Color, g.GroupColor, '')), 1, 1),
        TRIM(IFNULL(r.Kataban, '')),
        TRIM(IFNULL(r.Edaban, '')),
        IF(LENGTH(TRIM(COALESCE(s.Color, g.GroupColor, ''))) > 1, SUBSTR(TRIM(COALESCE(s.Color, g.GroupColor, '')), 2, 1), ''),
        CAST(IFNULL(r.RepresentativeLength, 0) AS STRING)
      ) AS \`副資材コード\`
    FROM res AS r
    LEFT JOIN stock_raw AS s ON r.EXTLotNo = s.STLotNo
    LEFT JOIN ind_group_colors AS g 
      ON r.EXTIndicationDate = g.EXTIndicationDate 
      AND r.EXTIndicationNo = g.EXTIndicationNo
  `;
  return executeQuery(sql);
}

function fetchDefectsFromBQ(dateFilter) {
  const sql = `
    SELECT
      d.EXTMachine AS \`号機\`,
      d.EXTDate AS \`押出日付\`,
      IFNULL(r.Kataban, '不明') AS \`型番\`,
      d.DefectiveCode AS \`不良コード\`,
      n.FormalName_Kanji AS \`不良名称\`,
      d.ReproductionWeight AS \`再生重量\`,
      d.DiscardWeight AS \`廃棄重量\`
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.DefectiveResultTR\` AS d
    LEFT JOIN (
      SELECT EXTIndicationDate, EXTIndicationNo, MAX(Kataban) as Kataban
      FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.EXTResultTR\`
      GROUP BY 1, 2
    ) AS r ON d.EXTIndicationDate = r.EXTIndicationDate AND d.EXTIndicationNo = r.EXTIndicationNo
    LEFT JOIN \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.NameMS\` AS n
      ON TRIM(d.DefectiveCode) = TRIM(n.NameKey) AND TRIM(n.ItemClass) = '38'
    WHERE ${dateFilter}
  `;
  return executeQuery(sql);
}

function fetchTimeFromBQ(dateFilter) {
  const sql = `
    SELECT
      t.EXTMachine AS \`号機\`,
      t.StartDate AS \`押出日付\`,
      t.StartTime AS \`開始時刻\`,
      t.TimeItem AS \`時間項目コード\`,
      n.FormalName_Kanji AS \`時間項目名\`,
      LEAD(t.StartTime) OVER(PARTITION BY t.EXTMachine, t.StartDate ORDER BY t.StartTime) as \`次開始時刻\`
    FROM \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.TimeResultResinTR\` AS t
    LEFT JOIN \`${BQ_CONFIG.PROJECT_ID}.${BQ_CONFIG.DATASET_ID}.NameMS\` AS n
      ON TRIM(t.TimeItem) = TRIM(n.NameKey) AND TRIM(n.ItemClass) = '08'
    WHERE ${dateFilter}
  `;
  return executeQuery(sql);
}

function executeQuery(sql) {
  const jobConfig = { configuration: { query: { query: sql, useLegacySql: false } } };
  const options = { location: BQ_CONFIG.LOCATION };
  try {
    const jobResult = BigQuery.Jobs.insert(jobConfig, BQ_CONFIG.PROJECT_ID);
    const jobId = jobResult.jobReference.jobId;
    while (true) {
      const currentJob = BigQuery.Jobs.get(BQ_CONFIG.PROJECT_ID, jobId, options);
      if (currentJob.status.state === 'DONE') {
        if (currentJob.status.errorResult) throw new Error(currentJob.status.errorResult.message);
        break;
      }
      Utilities.sleep(1500);
    }
    const queryResults = BigQuery.Jobs.getQueryResults(BQ_CONFIG.PROJECT_ID, jobId, options);
    if (!queryResults.rows) return [];
    const fields = queryResults.schema.fields.map(f => f.name);
    return queryResults.rows.map(row => {
      const obj = {};
      row.f.forEach((cell, i) => { obj[fields[i]] = cell.v; });
      return obj;
    });
  } catch (e) {
    console.error(`BQ Error: ${e.toString()}`);
    return [];
  }
}
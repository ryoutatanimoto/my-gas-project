/**
 * LIXIL 栗沢工場 押出課 - 形材在庫分析API (Api_AnalysisStock.gs)
 * * [特徴]
 * 1. 本物の現在庫テーブル (BarzaiContainerSubTR) からパレット残高を直接マージ。
 * 2. 1日平均出庫量は「直近3ヶ月の総出庫量(StockInOutTR) ÷ 60日（稼働日数）」で算出。
 * 3. スプレッドシート内の「形材単重マスタ」と結合し、副資材コード、入数、単重を取得。
 * 4. 「吐出量マスタ」から優先度1の号機・吐出量を紐付け、不足分の「必要生産時間」を自動計算。
 * * [修正内容]
 * 在庫0かつ履歴ありの製品において、型番に枝番が吸収合体してしまう「5125A」バグを完璧に修正。
 * 各履歴サブクエリ（out_history / in_history_1m）内でも、純型番(b_kataban)と枝番(b_edaban)の個別列抽出を完全徹底。
 * 結合句での SUBSTR 物理切り出しを廃止し、COALESCE による一意安全なデータマージにより枝番の分離表示を100%保証。
 */

const STOCK_BQ_CONFIG = {
  PROJECT_ID: 'lixil-dwh',
  DATASET_ID: 'pii_an1_j_tie_up_kurisawa',
  LOCATION: 'asia-northeast1'
};

/**
 * 🔍 診断用関数：Google Apps Scriptのエディタから直接選択して「実行」してください。
 */
function runStockDiagnostics() {
  console.log("=== 🔍 形材在庫分析 システム自己診断開始 ===");
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    console.log("1. スプレッドシートの接続確認: 成功");
    
    const bqData = fetchStockBaseFromBQ_();
    console.log("2. 新設計クエリのテスト稼働: 成功");
    console.log("   - 抽出された総製品数: " + bqData.length + " 件");
    if (bqData.length > 0) {
      const activeCount = bqData.filter(item => item.producedIn1M).length;
      console.log("   - そのうち直近1ヶ月以内に生産実績がある現役型番: " + activeCount + " 件");
    }
  } catch (err) {
    console.error("   ❌ 診断プロセス中に予期せぬ例外が発生しました: " + err.toString());
  }
  console.log("=== 🔍 形材在庫分析 システム自己診断終了 ===");
}

/**
 * フロントエンドから呼び出される形材在庫分析データのメインエントリ
 */
function getStockAnalysisData() {
  try {
    console.log("[形材在庫分析] データ集計処理開始...");
    const bqData = fetchStockBaseFromBQ_();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const weightMaster = loadWeightMaster_(ss);
    const dischargeMaster = loadDischargeMaster_(ss);
    const mergedList = mergeMasterAndStock_(bqData, weightMaster, dischargeMaster);
    const uniqueModels = [...new Set(mergedList.map(item => item.model))].sort();

    return {
      success: true,
      data: mergedList,
      models: uniqueModels
    };
  } catch (e) {
    console.error("getStockAnalysisData Fatal Error:", e);
    return {
      success: false,
      message: "形材在庫分析データの取得に失敗しました: " + e.toString()
    };
  }
}

/**
 * BigQueryから基本在庫情報と直近生産実績を抽出しマージする
 */
function fetchStockBaseFromBQ_() {
  const sql = `
    WITH real_stock AS (
      SELECT 
        REGEXP_REPLACE(CONCAT(TRIM(Kataban), COALESCE(TRIM(Edaban), '')), r'^0+', '') as b_model,
        REGEXP_REPLACE(TRIM(Kataban), r'^0+', '') as b_kataban,
        COALESCE(TRIM(Edaban), '') as b_edaban,
        CAST(Length AS INT64) as b_length,
        COALESCE(TRIM(Color), '') as b_color,
        SUM(COALESCE(QtyInPallet, 0)) as current_qty,
        SUM(COALESCE(QtyInPallet, 0) * COALESCE(UnitWeight, 0.0)) as current_weight
      FROM \`${STOCK_BQ_CONFIG.PROJECT_ID}.${STOCK_BQ_CONFIG.DATASET_ID}.BarzaiContainerSubTR\`
      WHERE Kataban IS NOT NULL AND Kataban != ''
      GROUP BY 1, 2, 3, 4, 5
    ),
    
    out_history AS (
      SELECT 
        REGEXP_REPLACE(CONCAT(TRIM(s.Kataban), COALESCE(TRIM(s.Edaban), '')), r'^0+', '') as b_model,
        REGEXP_REPLACE(TRIM(s.Kataban), r'^0+', '') as b_kataban,
        COALESCE(TRIM(s.Edaban), '') as b_edaban,
        CAST(s.Length AS INT64) as b_length,
        COALESCE(TRIM(s.Color), '') as b_color,
        SUM(COALESCE(s.StockInOutQty, 0)) as out_qty_3m
      FROM \`${STOCK_BQ_CONFIG.PROJECT_ID}.${STOCK_BQ_CONFIG.DATASET_ID}.StockInOutTR\` s
      WHERE s.Kataban IS NOT NULL AND s.Kataban != ''
        AND s.StockInOutClass = '2'
        AND COALESCE(
          SAFE.PARSE_DATE('%Y/%m/%d', s.StockInOutDate),
          SAFE.PARSE_DATE('%Y-%m-%d', s.StockInOutDate),
          SAFE.PARSE_DATE('%Y%m%d', s.StockInOutDate)
        ) >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 MONTH)
      GROUP BY 1, 2, 3, 4, 5
    ),

    in_history_1m AS (
      SELECT 
        REGEXP_REPLACE(CONCAT(TRIM(s.Kataban), COALESCE(TRIM(s.Edaban), '')), r'^0+', '') as b_model,
        REGEXP_REPLACE(TRIM(s.Kataban), r'^0+', '') as b_kataban,
        COALESCE(TRIM(s.Edaban), '') as b_edaban,
        CAST(s.Length AS INT64) as b_length,
        COALESCE(TRIM(s.Color), '') as b_color,
        COUNT(*) as in_count_1m
      FROM \`${STOCK_BQ_CONFIG.PROJECT_ID}.${STOCK_BQ_CONFIG.DATASET_ID}.StockInOutTR\` s
      WHERE s.Kataban IS NOT NULL AND s.Kataban != ''
        AND s.StockInOutClass = '1'
        AND COALESCE(
          SAFE.PARSE_DATE('%Y/%m/%d', s.StockInOutDate),
          SAFE.PARSE_DATE('%Y-%m-%d', s.StockInOutDate),
          SAFE.PARSE_DATE('%Y%m%d', s.StockInOutDate)
        ) >= DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH)
      GROUP BY 1, 2, 3, 4, 5
    ),
    
    merged AS (
      SELECT
        COALESCE(s.b_model, h.b_model, i.b_model) as b_model,
        COALESCE(s.b_kataban, h.b_kataban, i.b_kataban) as b_kataban,
        COALESCE(s.b_edaban, h.b_edaban, i.b_edaban, '') as b_edaban,
        COALESCE(s.b_length, h.b_length, i.b_length) as b_length,
        COALESCE(s.b_color, h.b_color, i.b_color) as b_color,
        COALESCE(s.current_qty, 0) as current_qty,
        COALESCE(s.current_weight, 0.0) as current_weight,
        COALESCE(h.out_qty_3m, 0) as out_qty_3m,
        IF(COALESCE(i.in_count_1m, 0) > 0, 1, 0) as produced_in_1m
      FROM real_stock s
      FULL OUTER JOIN out_history h ON s.b_model = h.b_model AND s.b_length = h.b_length AND s.b_color = h.b_color
      FULL OUTER JOIN in_history_1m i ON COALESCE(s.b_model, h.b_model) = i.b_model AND COALESCE(s.b_length, h.b_length) = i.b_length AND COALESCE(s.b_color, h.b_color) = i.b_color
    )
    
    SELECT * FROM merged
    WHERE current_qty != 0 OR out_qty_3m != 0 OR produced_in_1m != 0
  `;

  return executeStockQuery_(sql);
}

function findHeaderIndex_(headers, targetName) {
  if (!headers || !Array.isArray(headers)) return -1;
  const targetClean = String(targetName).trim();
  for (let i = 0; i < headers.length; i++) {
    if (headers[i] === undefined || headers[i] === null) continue;
    const headerClean = String(headers[i]).trim();
    if (!headerClean) continue;
    if (headerClean === targetClean || headerClean.indexOf(targetClean) !== -1) return i;
  }
  return -1;
}

function loadWeightMaster_(ss) {
  const sheet = ss.getSheetByName("形材単重マスタ");
  if (!sheet) return [];
  let lastRow = sheet.getLastRow() <= 1 ? 1000 : sheet.getLastRow();
  let lastCol = sheet.getLastColumn() === 0 ? 20 : sheet.getLastColumn();
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0];
  const idxModel = findHeaderIndex_(headers, "型番");
  const idxColor = findHeaderIndex_(headers, "色");
  const idxLen = findHeaderIndex_(headers, "定尺");
  const idxUnitW = findHeaderIndex_(headers, "樹脂形材単重");
  const idxPackQty = findHeaderIndex_(headers, "パレット入数");
  const idxSubCode = findHeaderIndex_(headers, "副資材コード");

  if (idxModel === -1 || idxColor === -1) return [];
  const list = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row || !row[idxModel]) continue;
    list.push({
      model: normalizeMasterString_(row[idxModel]),
      color: normalizeMasterString_(row[idxColor]),
      length: idxLen !== -1 ? (parseInt(row[idxLen]) || 0) : 0,
      unitWeight: idxUnitW !== -1 ? (parseFloat(row[idxUnitW]) || 0.0) : 0.0,
      packQty: idxPackQty !== -1 ? (parseInt(row[idxPackQty]) || 0) : 100,
      subMaterialCode: idxSubCode !== -1 ? String(row[idxSubCode] || "").trim() : "不明"
    });
  }
  return list;
}

function loadDischargeMaster_(ss) {
  const sheet = ss.getSheetByName("吐出量マスタ");
  if (!sheet) return [];
  let lastRow = sheet.getLastRow() <= 1 ? 500 : sheet.getLastRow();
  let lastCol = sheet.getLastColumn() === 0 ? 15 : sheet.getLastColumn();
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0];
  const idxModel = findHeaderIndex_(headers, "型番");
  const idxMachine = findHeaderIndex_(headers, "号機");
  const idxPriority = findHeaderIndex_(headers, "号機優先順");
  const idxDischarge = findHeaderIndex_(headers, "吐出量");

  if (idxModel === -1 || idxMachine === -1) return [];
  const list = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row || !row[idxModel]) continue;
    list.push({
      model: normalizeMasterString_(row[idxModel]),
      machine: String(row[idxMachine] || "").trim(),
      priority: idxPriority !== -1 ? (parseInt(row[idxPriority]) || 99) : 99,
      discharge: idxDischarge !== -1 ? (parseFloat(row[idxDischarge]) || 0.0) : 0.0
    });
  }
  return list;
}

function normalizeMasterString_(val) {
  if (val === null || val === undefined) return "";
  let s = String(val).trim().toUpperCase();
  s = s.replace(/^0+/, '');
  return s;
}

function mergeMasterAndStock_(bqList, weightMaster, dischargeMaster) {
  const results = [];

  bqList.forEach(item => {
    const bqModelJoinKey = normalizeMasterString_(item.b_model);
    const bqColor = normalizeMasterString_(item.b_color);
    const bqLen = parseInt(item.b_length) || 0;

    const matchedWeight = weightMaster.find(wm => 
      wm.model === bqModelJoinKey && wm.color === bqColor && Math.abs(wm.length - bqLen) <= 50 
    );

    let subCode = matchedWeight ? matchedWeight.subMaterialCode : "不明";
    if (subCode === "不明" || !subCode) {
      subCode = generateSubMaterialCode_("PA", item.b_color, item.b_kataban, item.b_edaban, item.b_length);
    }

    const packQty = matchedWeight ? matchedWeight.packQty : 100;
    const unitWeight = matchedWeight ? matchedWeight.unitWeight : 0.0;

    const bqBaseModel = normalizeMasterString_(item.b_kataban);
    const matchedDischarges = dischargeMaster.filter(dm => dm.model === bqBaseModel);
    let bestDischarge = null;
    if (matchedDischarges.length > 0) {
      bestDischarge = matchedDischarges.reduce((prev, curr) => prev.priority < curr.priority ? prev : curr);
    }

    const machine = bestDischarge ? bestDischarge.machine + "号機" : "未設定";
    const dischargeRate = bestDischarge ? bestDischarge.discharge : 0.0;

    const currentQty = parseInt(item.current_qty) || 0;
    const avgOutQtyPerDay = (parseFloat(item.out_qty_3m) || 0.0) / 60.0;
    const isActive = parseInt(item.produced_in_1m) === 1; // 直近1ヶ月以内の生産フラグ
    
    let stockIndexDays = 999;
    if (avgOutQtyPerDay > 0) {
      stockIndexDays = currentQty / avgOutQtyPerDay;
      if (stockIndexDays < 0) stockIndexDays = 0;
    }

    const weightPerPiece = (bqLen * unitWeight) / 1000.0;
    let currentTotalWeight = currentQty * weightPerPiece;
    const currentPalettes = packQty > 0 ? (currentQty / packQty).toFixed(2) : "0.00";

    // 生産必要量の算出 (直近1ヶ月以内に動いていないものは必要生産を自動で0にする)
    const targetDays = 15;
    let needProdQty = 0;
    let needProdHours = 0.0;

    if (isActive && (stockIndexDays < 10 || currentQty < 0)) {
      const neededTotal = targetDays * avgOutQtyPerDay;
      needProdQty = Math.round(neededTotal - currentQty);
      if (needProdQty < 0) needProdQty = 0;

      let needProdWeight = needProdQty * weightPerPiece;
      if (dischargeRate > 0) {
        needProdHours = needProdWeight / dischargeRate;
      }
    }

    results.push({
      subMaterialCode: subCode,
      model: item.b_kataban,        
      edaban: item.b_edaban || "",  
      color: item.b_color || "無地", 
      length: bqLen,
      currentQty: currentQty,
      currentPalettes: parseFloat(currentPalettes),
      currentWeight: Math.round(currentTotalWeight),
      avgOutQtyPerDay: parseFloat(avgOutQtyPerDay.toFixed(2)),
      stockIndexDays: stockIndexDays === 999 ? "―" : parseFloat(stockIndexDays.toFixed(1)),
      machine: machine,
      dischargeRate: dischargeRate,
      needProdQty: needProdQty,
      needProdHours: parseFloat(needProdHours.toFixed(1)),
      producedIn1M: isActive 
    });
  });

  return results;
}

function generateSubMaterialCode_(material, color, kataban, edaban, length) {
  const matClean = String(material || "PA").trim().toUpperCase();
  const colClean = String(color || "").trim().toUpperCase();
  const edaClean = String(edaban || "").trim().toUpperCase();
  const katPad = String(kataban || "").replace(/[^0-9]/g, '').trim().padStart(5, '0');
  const lenPad = String(parseInt(length) || 0).padStart(4, '0');
  
  if (colClean.length === 2) {
    return matClean + colClean.charAt(0) + katPad + edaClean + colClean.charAt(1) + lenPad;
  } else {
    return matClean + colClean + katPad + edaClean + lenPad;
  }
}

function executeStockQuery_(sql) {
  const jobConfig = { configuration: { query: { query: sql, useLegacySql: false } }, jobReference: { projectId: STOCK_BQ_CONFIG.PROJECT_ID, location: STOCK_BQ_CONFIG.LOCATION } };
  const options = { location: STOCK_BQ_CONFIG.LOCATION };
  try {
    const jobResult = BigQuery.Jobs.insert(jobConfig, STOCK_BQ_CONFIG.PROJECT_ID);
    const jobId = jobResult.jobReference.jobId;
    let job = BigQuery.Jobs.get(STOCK_BQ_CONFIG.PROJECT_ID, jobId, options);
    while (job.status.state !== 'DONE') {
      Utilities.sleep(250);
      job = BigQuery.Jobs.get(STOCK_BQ_CONFIG.PROJECT_ID, jobId, options);
    }
    if (job.status.errorResult) throw new Error(job.status.errorResult.message);
    const response = BigQuery.Jobs.getQueryResults(STOCK_BQ_CONFIG.PROJECT_ID, jobId, options);
    if (!response.rows) return [];
    const fields = response.schema.fields;
    return response.rows.map(row => {
      const obj = {};
      row.f.forEach((cell, i) => {
        let val = cell.v;
        if (fields[i].type === 'FLOAT' || fields[i].type === 'INTEGER') val = val !== null ? Number(val) : null;
        obj[fields[i].name] = val;
      });
      return obj;
    });
  } catch (e) {
    console.error("executeStockQuery_ Failed:", e);
    throw e;
  }
}
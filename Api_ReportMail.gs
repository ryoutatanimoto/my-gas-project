/**
 * LIXIL 栗沢工場 APMシステム - 操業日報メール配信API (Api_ReportMail.gs)
 * [直行率・当直サマリー・不良ワースト3全自動算出機能搭載決定版 - 各号機別「純不良内訳」「ロス内訳」2列完全分離版]
 */

// グローバル定数の一意定義
const APM_REP_MAIL_CONFIG = {
  PROJECT_ID_WORK: 'lixil-workspace',
  DATASET_ID_WORK: 'an1_kurisawa_oshidashi',
  PROJECT_ID_DWH: 'lixil-dwh',
  DATASET_ID_DWH: 'pii_an1_j_tie_up_kurisawa',
  LOCATION: 'asia-northeast1',
  SHEET_NAME_MASTER: 'メールアドレスマスタ'
};

/**
 * 1. スプレッドシートの「メールアドレスマスタ」からアドレス一覧を取得
 */
function getMailMasterAddresses() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(APM_REP_MAIL_CONFIG.SHEET_NAME_MASTER);
    if (!sheet) {
      console.warn(`「${APM_REP_MAIL_CONFIG.SHEET_NAME_MASTER}」シートが見つかりません。`);
      return [];
    }
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    const addresses = [];
    for (let i = 0; i < values.length; i++) {
      const email = values[i][1] ? values[i][1].toString().trim() : "";
      if (email && email.indexOf('@') !== -1) {
        addresses.push(email);
      }
    }
    return addresses;
  } catch (e) {
    console.error("getMailMasterAddresses Error:", e);
    return [];
  }
}

/**
 * 2. 各テーブルから操業データを自動集計してフロントに返す (統計情報・ワーストランキング付き)
 */
function assembleDailyReportData(date, shift, group) {
  try {
    if (!date) throw new Error("対象日付が指定されていません。");
    if (!shift) throw new Error("対象直が指定されていません。");

    const formattedDate = date.replace(/-/g, '/'); // YYYY/MM/DD
    const shiftLabel = shift.indexOf('直') === -1 ? shift + '直' : shift;
    
    console.log(`[日報データ集計開始] 日付: ${formattedDate}, 直: ${shiftLabel}, 班: ${group}`);
    
    // (A) 粉砕・ペレタイザー実績の取得
    const pelletData = getPelletRecordForReport_(date, shiftLabel);
    
    // (B) 各号機のLDPデータ高度集計
    const machineRecords = getLdpMachineRecords_(date, shift);

    // デフォルトの配信先アドレス
    const toList = getMailMasterAddresses();

    return {
      success: true,
      date: formattedDate,
      shift: shiftLabel,
      group: group,
      pellet: pelletData,
      machines: machineRecords.machines,
      summary: machineRecords.summary, // 直行率・不良ロス内訳・不良ランキングなどの統計情報
      defaultTo: toList.join(', '),
      defaultCc: ""
    };

  } catch (e) {
    console.error('assembleDailyReportData Error:', e);
    return {
      success: false,
      message: '日報データ集計中に致命的エラーが発生しました: ' + e.toString()
    };
  }
}

/**
 * 3. 完成したHTML日報メールを宛先へ送信
 */
function sendFormattedEmail(to, cc, subject, bodyHtml) {
  try {
    if (!to) throw new Error("送信宛先(To)が設定されていません。");
    const options = {
      htmlBody: bodyHtml
    };
    if (cc && cc.trim() !== "") {
      options.cc = cc.trim();
    }
    
    GmailApp.sendEmail(to, subject, "押出課 操業日報配信", options);
    return { success: true };
  } catch (e) {
    console.error("sendFormattedEmail Error:", e);
    return { success: false, message: e.toString() };
  }
}

/**
 * 4. 号機IDの揺れを完璧に正規化するJavaScript関数
 */
function normalizeMachineId(rawId) {
  if (rawId === null || rawId === undefined) return "";
  let m = String(rawId).trim().toUpperCase();
  
  // 全角英数字を半角に変換
  m = m.replace(/[０-９Ａ-Ｚ]/g, function(s) {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  });
  
  m = m.replace(/号機/g, "").replace(/\.0$/, "").replace(/^0+/, "");

  if (m === "8" || m === "08" || m === "8A") return "8A";
  if (m === "8B") return "8B";
  return m;
}

/**
 * 5. 色型番のインテリジェント合体コードフォーマッタ
 */
function formatProductCode(color, kataban) {
  if (!kataban) return "";
  let c = String(color || "").trim().toUpperCase();
  let k = String(kataban || "").trim();
  
  // 全角英数字を半角に強制標準化
  c = c.replace(/[０-９Ａ-Ｚ]/g, function(s) {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  });
  k = k.replace(/[０-９Ａ-Ｚ]/g, function(s) {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  });

  if (!c) return k;

  if (c.length === 1) {
    return c + k;
  } else if (c.length === 2) {
    return c.charAt(0) + k + c.charAt(1);
  } else {
    return c + k;
  }
}

/**
 * 6. 粉砕・ペレタイザー実績の取得 (特定日付・直) - 実カラム名整合版
 */
function getPelletRecordForReport_(date, shiftLabel) {
  const parts = date.split('-');
  const year = parts[0];
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  
  const date8 = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  const dateShort = `${year}${month}${day}`;
  const shiftNum = shiftLabel.replace(/[^0-9]/g, '');

  const sql = `
    SELECT 
      COALESCE(white_scrap_time, 0) AS white_scrap_time,
      COALESCE(color_scrap_weight, 0.0) AS color_scrap_weight,
      COALESCE(color_scrap_time, 0) AS color_scrap_time,
      COALESCE(pellet_weight, 0.0) AS pellet_weight,
      COALESCE(pellet_time, 0) AS pellet_time,
      COALESCE(pellet_type, '') AS pellet_type
    FROM \`${APM_REP_MAIL_CONFIG.PROJECT_ID_WORK}.${APM_REP_MAIL_CONFIG.DATASET_ID_WORK}.input_scrap_pellet\`
    WHERE (
      REGEXP_REPLACE(CAST(work_date AS STRING), r'[^0-9]', '') LIKE '${date8}%'
      OR REGEXP_REPLACE(CAST(work_date AS STRING), r'[^0-9]', '') LIKE '${dateShort}%'
    )
    AND REGEXP_REPLACE(TRANSLATE(CAST(shift AS STRING), '１２３', '123'), r'[^0-9]', '') = '${shiftNum}'
    LIMIT 1
  `;
  try {
    const res = runQuietQueryForReport_(sql, APM_REP_MAIL_CONFIG.PROJECT_ID_WORK);
    return res && res.length > 0 ? res[0] : { white_scrap_time: 0, color_scrap_weight: 0, color_scrap_time: 0, pellet_weight: 0, pellet_time: 0, pellet_type: "" };
  } catch (e) {
    console.warn("pelletData fetch warning:", e);
    return { white_scrap_time: 0, color_scrap_weight: 0, color_scrap_time: 0, pellet_weight: 0, pellet_time: 0, pellet_type: "" };
  }
}

/**
 * 7. 時刻フォーマット「HH:mm:ss」を「HH:mm」（分単位）に強制統一するヘルパー関数
 */
function formatTimeHHMM_(timeStr) {
  if (!timeStr) return "";
  const parts = String(timeStr).trim().split(':');
  if (parts.length >= 2) {
    return parts[0].padStart(2, '0') + ':' + parts[1].padStart(2, '0');
  }
  return timeStr;
}

/**
 * 8. 時間コードから標準の日本語名称を割り当てる関数
 */
function getTimeItemNameByCode_(code, dbName) {
  const cleanDbName = String(dbName || "").trim();
  if (cleanDbName !== "") return cleanDbName;

  const c = String(code || "").trim();
  if (c === "00") return "押出稼働";
  if (c === "01") return "金型セット";
  if (c === "02") return "色替作業";
  if (c === "08") return "昇温";
  if (c === "12") return "立上作業";
  if (c === "13") return "立上サイジング";
  if (c === "14") return "停止作業";
  if (c === "25") return "故障トラブル";
  return "その他作業ロス";
}

/**
 * 9. 1号機〜12号機別操業・品質データの集計 (直行率 & 全体不良ワースト3付き)
 */
function getLdpMachineRecords_(date, shift) {
  const parts = date.split('-');
  const year = parts[0];
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  
  const date8 = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  const dateShort = `${year}${month}${day}`;
  const shiftNum = shift.replace(/[^0-9]/g, '');

  const dObj = new Date(year, month - 1, day);
  let prevDate8 = date8;
  let prevDateShort = dateShort;
  let prevShiftNum = '1';

  if (shiftNum === '1') {
    const prevDay = new Date(dObj.getTime() - 24 * 60 * 60 * 1000);
    const pY = prevDay.getFullYear();
    const pM = prevDay.getMonth() + 1;
    const pD = prevDay.getDate();
    prevDate8 = `${pY}${String(pM).padStart(2, '0')}${String(pD).padStart(2, '0')}`;
    prevDateShort = `${pY}${pM}${pD}`;
    prevShiftNum = '3';
  } else if (shiftNum === '2') {
    prevShiftNum = '1';
  } else if (shiftNum === '3') {
    prevShiftNum = '2';
  }

  const d1 = new Date(dObj.getTime() - 24 * 60 * 60 * 1000);
  const d2 = new Date(dObj.getTime() - 2 * 24 * 60 * 60 * 1000);
  const d3 = new Date(dObj.getTime() - 3 * 24 * 60 * 60 * 1000);
  const pastDatesList = [
    `${d1.getFullYear()}${String(d1.getMonth() + 1).padStart(2, '0')}${String(d1.getDate()).padStart(2, '0')}`,
    `${d2.getFullYear()}${String(d2.getMonth() + 1).padStart(2, '0')}${String(d2.getDate()).padStart(2, '0')}`,
    `${d3.getFullYear()}${String(d3.getMonth() + 1).padStart(2, '0')}${String(d3.getDate()).padStart(2, '0')}`
  ];

  const prodSql = `
    WITH stock_raw AS (
      SELECT 
        COALESCE(TRIM(STLotNo), TRIM(EXTLotNo)) as STLotNo, 
        MAX(Color) as Color
      FROM \`${APM_REP_MAIL_CONFIG.PROJECT_ID_DWH}.${APM_REP_MAIL_CONFIG.DATASET_ID_DWH}.StockInOutTR\`
      WHERE (STLotNo IS NOT NULL AND STLotNo != '') OR (EXTLotNo IS NOT NULL AND EXTLotNo != '')
      GROUP BY 1
    ),
    
    ind_group_colors AS (
      SELECT 
        SUBSTR(REGEXP_REPLACE(CAST(r_all.EXTIndicationDate AS STRING), r'[^0-9]', ''), 1, 8) AS norm_ind_date,
        TRIM(r_all.EXTIndicationNo) AS norm_ind_no,
        COALESCE(
          MAX(IF(REGEXP_REPLACE(CAST(r_all.EXTIndicationSub1 AS STRING), r'[^0-9]', '') = '0', TRIM(s.Color), NULL)),
          MAX(TRIM(s.Color))
        ) as GroupColor
      FROM \`${APM_REP_MAIL_CONFIG.PROJECT_ID_DWH}.${APM_REP_MAIL_CONFIG.DATASET_ID_DWH}.EXTResultTR\` r_all
      JOIN stock_raw s ON TRIM(r_all.EXTLotNo) = s.STLotNo
      WHERE s.Color IS NOT NULL AND TRIM(s.Color) != ''
      GROUP BY 1, 2
    ),

    base_prod AS (
      SELECT
        TRIM(CAST(r.EXTMachine AS STRING)) AS machine_id,
        TRIM(r.Kataban) AS Kataban,
        r.GoodQty,
        r.UnitWeight,
        r.RepresentativeLength,
        r.EXTDate,
        SUBSTR(REGEXP_REPLACE(CAST(r.EXTIndicationDate AS STRING), r'[^0-9]', ''), 1, 8) AS norm_ind_date,
        TRIM(r.EXTIndicationNo) AS norm_ind_no
      FROM \`${APM_REP_MAIL_CONFIG.PROJECT_ID_DWH}.${APM_REP_MAIL_CONFIG.DATASET_ID_DWH}.EXTResultTR\` r
      WHERE (
        REGEXP_REPLACE(CAST(r.EXTDate AS STRING), r'[^0-9]', '') LIKE '${date8}%'
        OR REGEXP_REPLACE(CAST(r.EXTDate AS STRING), r'[^0-9]', '') LIKE '${dateShort}%'
      )
      AND REGEXP_REPLACE(TRANSLATE(CAST(r.EXTShift AS STRING), '１２３', '123'), r'[^0-9]', '') = '${shiftNum}'
    ),

    base_prod_with_color AS (
      SELECT 
        b.*,
        COALESCE(c.GroupColor, '') AS Color
      FROM base_prod b
      LEFT JOIN ind_group_colors c
        ON b.norm_ind_date = c.norm_ind_date
       AND b.norm_ind_no = c.norm_ind_no
    ),

    prev_base_prod AS (
      SELECT
        TRIM(CAST(r.EXTMachine AS STRING)) AS machine_id,
        TRIM(r.Kataban) AS Kataban,
        r.EXTDate,
        SUBSTR(REGEXP_REPLACE(CAST(r.EXTIndicationDate AS STRING), r'[^0-9]', ''), 1, 8) AS norm_ind_date,
        TRIM(r.EXTIndicationNo) AS norm_ind_no
      FROM \`${APM_REP_MAIL_CONFIG.PROJECT_ID_DWH}.${APM_REP_MAIL_CONFIG.DATASET_ID_DWH}.EXTResultTR\` r
      WHERE (
        REGEXP_REPLACE(CAST(r.EXTDate AS STRING), r'[^0-9]', '') LIKE '${prevDate8}%'
        OR REGEXP_REPLACE(CAST(r.EXTDate AS STRING), r'[^0-9]', '') LIKE '${prevDateShort}%'
      )
      AND REGEXP_REPLACE(TRANSLATE(CAST(r.EXTShift AS STRING), '１２３', '123'), r'[^0-9]', '') = '${prevShiftNum}'
    ),

    prev_prod_with_color AS (
      SELECT 
        p.*,
        COALESCE(c.GroupColor, '') AS Color
      FROM prev_base_prod p
      LEFT JOIN ind_group_colors c
        ON p.norm_ind_date = c.norm_ind_date
       AND p.norm_ind_no = c.norm_ind_no
    ),

    past_base_prod AS (
      SELECT
        TRIM(CAST(r.EXTMachine AS STRING)) AS machine_id,
        TRIM(r.Kataban) AS Kataban,
        r.EXTDate,
        SUBSTR(REGEXP_REPLACE(CAST(r.EXTIndicationDate AS STRING), r'[^0-9]', ''), 1, 8) AS norm_ind_date,
        TRIM(r.EXTIndicationNo) AS norm_ind_no
      FROM \`${APM_REP_MAIL_CONFIG.PROJECT_ID_DWH}.${APM_REP_MAIL_CONFIG.DATASET_ID_DWH}.EXTResultTR\` r
      WHERE (
        REGEXP_REPLACE(CAST(r.EXTDate AS STRING), r'[^0-9]', '') LIKE '${pastDatesList[0]}%'
        OR REGEXP_REPLACE(CAST(r.EXTDate AS STRING), r'[^0-9]', '') LIKE '${pastDatesList[1]}%'
        OR REGEXP_REPLACE(CAST(r.EXTDate AS STRING), r'[^0-9]', '') LIKE '${pastDatesList[2]}%'
      )
    ),

    past_prod_with_color AS (
      SELECT 
        p.*,
        COALESCE(c.GroupColor, '') AS Color
      FROM past_base_prod p
      LEFT JOIN ind_group_colors c
        ON p.norm_ind_date = c.norm_ind_date
       AND p.norm_ind_no = c.norm_ind_no
    ),

    curr_last_color AS (
      SELECT
        machine_id,
        Kataban as last_model,
        Color as last_color
      FROM (
        SELECT 
          machine_id, Kataban, Color,
          ROW_NUMBER() OVER(PARTITION BY machine_id ORDER BY EXTDate DESC) as rn
        FROM base_prod_with_color
        WHERE Color != '' AND Color IS NOT NULL
      )
      WHERE rn = 1
    ),

    prev_last_color AS (
      SELECT
        machine_id,
        Kataban as prev_model,
        Color as prev_color
      FROM (
        SELECT 
          machine_id, Kataban, Color,
          ROW_NUMBER() OVER(PARTITION BY machine_id ORDER BY EXTDate DESC) as rn
        FROM (
          SELECT machine_id, Kataban, Color, EXTDate FROM prev_prod_with_color
          UNION ALL
          SELECT machine_id, Kataban, Color, EXTDate FROM past_prod_with_color
        )
        WHERE Color != '' AND Color IS NOT NULL
      )
      WHERE rn = 1
    )

    SELECT
      b.machine_id,
      b.Kataban AS model,
      MAX(b.Color) AS color,
      SUM(COALESCE(b.GoodQty, 0) * COALESCE(b.UnitWeight, 0) * COALESCE(b.RepresentativeLength, 0)) / 1000.0 AS production_weight,
      MAX(curr_lc.last_model) AS last_model,
      MAX(curr_lc.last_color) AS last_color,
      MAX(prev_lc.prev_model) AS prev_model,
      MAX(prev_lc.prev_color) AS prev_color
    FROM base_prod_with_color b
    LEFT JOIN curr_last_color curr_lc ON b.machine_id = curr_lc.machine_id
    LEFT JOIN prev_last_color prev_lc ON b.machine_id = prev_lc.machine_id
    WHERE b.machine_id IS NOT NULL AND b.machine_id != ''
    GROUP BY b.machine_id, b.Kataban
  `;

  const defectSql = `
    SELECT
      TRIM(CAST(d.EXTMachine AS STRING)) as machine_id,
      TRIM(d.DefectiveCode) as defect_code,
      n.FormalName_Kanji as defect_name,
      d.ReproductionWeight as rep_weight,
      d.DiscardWeight as disc_weight
    FROM \`${APM_REP_MAIL_CONFIG.PROJECT_ID_DWH}.${APM_REP_MAIL_CONFIG.DATASET_ID_DWH}.DefectiveResultTR\` d
    LEFT JOIN \`${APM_REP_MAIL_CONFIG.PROJECT_ID_DWH}.${APM_REP_MAIL_CONFIG.DATASET_ID_DWH}.NameMS\` n
      ON TRIM(d.DefectiveCode) = TRIM(n.NameKey) AND TRIM(n.ItemClass) = '38'
    WHERE (
      REGEXP_REPLACE(CAST(d.EXTDate AS STRING), r'[^0-9]', '') LIKE '${date8}%'
      OR REGEXP_REPLACE(CAST(d.EXTDate AS STRING), r'[^0-9]', '') LIKE '${dateShort}%'
    )
    AND REGEXP_REPLACE(TRANSLATE(CAST(d.EXTShift AS STRING), '１２３', '123'), r'[^0-9]', '') = '${shiftNum}'
  `;

  let shiftTimeFilter = "";
  let currentShiftLimit = "24:00";
  if (shiftNum === '1') {
    shiftTimeFilter = "AND t.StartTime >= '00:00' AND t.StartTime < '08:30'";
    currentShiftLimit = "08:30";
  } else if (shiftNum === '2') {
    shiftTimeFilter = "AND t.StartTime >= '08:30' AND t.StartTime < '17:05'";
    currentShiftLimit = "17:05";
  } else if (shiftNum === '3') {
    shiftTimeFilter = "AND t.StartTime >= '17:05' AND t.StartTime <= '23:59'";
    currentShiftLimit = "24:00";
  }
  
  const timeSql = `
    SELECT
      TRIM(CAST(t.EXTMachine AS STRING)) as machine_id,
      t.StartTime as start_time,
      t.TimeItem as time_item_code,
      n.FormalName_Kanji as time_name,
      LEAD(t.StartTime) OVER(PARTITION BY t.EXTMachine ORDER BY t.StartTime ASC) as next_start_time
    FROM \`${APM_REP_MAIL_CONFIG.PROJECT_ID_DWH}.${APM_REP_MAIL_CONFIG.DATASET_ID_DWH}.TimeResultResinTR\` t
    LEFT JOIN \`${APM_REP_MAIL_CONFIG.PROJECT_ID_DWH}.${APM_REP_MAIL_CONFIG.DATASET_ID_DWH}.NameMS\` n
      ON TRIM(t.TimeItem) = TRIM(n.NameKey) AND TRIM(n.ItemClass) = '08'
    WHERE (
      REGEXP_REPLACE(CAST(t.StartDate AS STRING), r'[^0-9]', '') LIKE '${date8}%'
      OR REGEXP_REPLACE(CAST(t.StartDate AS STRING), r'[^0-9]', '') LIKE '${dateShort}%'
    )
    ${shiftTimeFilter}
    ORDER BY t.EXTMachine, t.StartTime ASC
  `;

  // 出力用マスタ定義
  const machinesList = ['1','2','3','4','5','6','7','8A','8B','9','10','11','12'];
  const results = {};
  machinesList.forEach(m => {
    results[m] = {
      machine_id: m,
      models: [],
      colors: [],
      production_weight: 0,
      defect_weight: 0, // 純不良
      loss_weight: 0,   // ロス
      defects_top3: "",
      loss_top3: "",    // 各号機のロス内訳
      color_change: "",
      last_event: "",
      timeline_text: '<span class="text-slate-300">実績時間データなし</span>',
      hide_machine: false
    };
  });

  try {
    const prodRows = runQuietQueryForReport_(prodSql, APM_REP_MAIL_CONFIG.PROJECT_ID_DWH);
    const defectRows = runQuietQueryForReport_(defectSql, APM_REP_MAIL_CONFIG.PROJECT_ID_DWH);
    const timeRows = runQuietQueryForReport_(timeSql, APM_REP_MAIL_CONFIG.PROJECT_ID_DWH);

    let totalGood = 0;
    let totalDefect = 0; // 純不良の総計
    let totalLoss = 0;   // ロスの総計
    
    // 全体の不良項目をソートするための蓄積用（純不良のみ）
    const allDefectsSummary = [];

    // (A) 生産実績マッピング
    prodRows.forEach(r => {
      const m = normalizeMachineId(r.machine_id);
      if (!m || !results[m]) return;
      
      const pWeight = parseFloat(r.production_weight) || 0;
      results[m].production_weight += pWeight;
      totalGood += pWeight;
      
      const model = String(r.model || "").trim();
      if (model && !results[m].models.includes(model)) {
        results[m].models.push(model);
      }
      
      const color = String(r.color || "").trim();
      if (color && !results[m].colors.includes(color)) {
        results[m].colors.push(color);
      }

      const prevColor = String(r.prev_color || "").trim();
      const prevModel = String(r.prev_model || "").trim();
      const lastColor = String(r.last_color || "").trim();
      const lastModel = String(r.last_model || "").trim();

      const prevProductCode = formatProductCode(prevColor, prevModel);
      const currProductCode = formatProductCode(lastColor, lastModel);

      if (prevProductCode && currProductCode && prevProductCode !== currProductCode) {
        results[m].color_change = `${prevProductCode} → ${currProductCode}`;
      } else if (currProductCode) {
        results[m].color_change = currProductCode;
      } else if (prevProductCode) {
        results[m].color_change = prevProductCode;
      } else {
        results[m].color_change = formatProductCode(color, model);
      }
    });

    // (B) 不良実績マッピング
    const defectGroup = {};
    const lossGroup = {}; // 号機別のロス内訳集計用
    defectRows.forEach(r => {
      const m = normalizeMachineId(r.machine_id);
      if (!m || !results[m]) return;

      const rep = parseFloat(r.rep_weight) || 0;
      const disc = parseFloat(r.disc_weight) || 0;
      const totalDefectRow = rep + disc;

      const dName = String(r.defect_name || "その他").trim();
      const dCode = String(r.defect_code || "").trim();

      // ロスの判定ロジック (特定のコード、または名前に「ロス」や「ﾛｽ」が含まれているもの)
      const isLoss = dName.indexOf('ロス') !== -1 || dName.indexOf('ﾛｽ') !== -1 || 
                     ['00','01','02','03','10','11','20','21','22','30','31','32','33'].includes(dCode);

      if (isLoss) {
        // ロス重量に計上
        results[m].loss_weight += totalDefectRow;
        totalLoss += totalDefectRow;

        if (!lossGroup[m]) lossGroup[m] = {};
        lossGroup[m][dName] = (lossGroup[m][dName] || 0) + totalDefectRow;
      } else {
        // 不良重量に計上
        results[m].defect_weight += totalDefectRow;
        totalDefect += totalDefectRow;

        if (!defectGroup[m]) defectGroup[m] = {};
        defectGroup[m][dName] = (defectGroup[m][dName] || 0) + totalDefectRow;

        // 全体不良ワースト3集計用の登録 (純不良のみを登録して現場改善に生かします)
        const foundIdx = allDefectsSummary.findIndex(item => item.machine_id === m && item.defect_name === dName);
        if (foundIdx !== -1) {
          allDefectsSummary[foundIdx].weight += totalDefectRow;
        } else {
          allDefectsSummary.push({ machine_id: m, defect_name: dName, weight: totalDefectRow });
        }
      }
    });

    // 各号機別の詳細内訳文字列を生成
    Object.keys(results).forEach(m => {
      // 純不良内訳
      if (defectGroup[m]) {
        const sorted = Object.entries(defectGroup[m])
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([name, w]) => `${name}:${w.toFixed(1)}kg`);
        
        if (sorted.length > 0) {
          results[m].defects_top3 = `(${sorted.join(', ')})`;
        }
      }

      // ロス内訳
      if (lossGroup[m]) {
        const sortedLoss = Object.entries(lossGroup[m])
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([name, w]) => `${name}:${w.toFixed(1)}kg`);
        
        if (sortedLoss.length > 0) {
          results[m].loss_top3 = `(${sortedLoss.join(', ')})`;
        }
      }
    });

    // (C) 号機ごとの詳細な活動時間帯の自動抽出・直ごとの切り詰めロジック
    const machineTimeDetails = {};
    machinesList.forEach(m => {
      machineTimeDetails[m] = {
        timeline: [],
        lastEvent: ""
      };
    });

    timeRows.forEach(r => {
      const m = normalizeMachineId(r.machine_id);
      if (!m || !machineTimeDetails[m]) return;

      const code = String(r.time_item_code || "").trim();
      const dbName = String(r.time_name || "").trim();
      
      // 名称補完
      const name = getTimeItemNameByCode_(code, dbName);
      
      // 時刻フォーマットを秒なしの "HH:mm" に強制変換
      const start = formatTimeHHMM_(r.start_time);
      
      let end = formatTimeHHMM_(r.next_start_time);
      if (!end) {
        end = formatTimeHHMM_(currentShiftLimit); // 直ごとの制限終了時間
      }

      if (start === end) return;

      const timeRangeStr = `<div>${start}～${end} : ${name}</div>`;
      machineTimeDetails[m].timeline.push(timeRangeStr);
      machineTimeDetails[m].lastEvent = name;
    });

    // 時系列テキストリストの結合・マッピング
    Object.keys(results).forEach(m => {
      const details = machineTimeDetails[m];
      results[m].timeline_text = details.timeline.length > 0 ? details.timeline.join('') : '<span class="text-slate-300">実績時間データなし</span>';
      results[m].last_event = details.lastEvent || "";
    });

    // 稼働なし号機の消去判定 (不良、ロスの両方が0の場合に判定)
    const targetEndJobs = ['停止作業', '金型セット', '金型ｾｯﾄ', '昇温', '色替作業', '色替'];
    
    Object.keys(results).forEach(m => {
      const res = results[m];
      if (res.production_weight === 0 && res.defect_weight === 0 && res.loss_weight === 0) {
        const lastJob = res.last_event;
        const isTargetJob = targetEndJobs.some(job => lastJob.indexOf(job) !== -1);
        if (!isTargetJob) {
          res.hide_machine = true;
        }
      }
    });

    // 当直不良ワースト3ランキングの決定
    const worstDefectsList = allDefectsSummary
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((item, idx) => `${idx + 1}位: ${item.machine_id}号機 (${item.defect_name}: ${item.weight.toFixed(1)}kg)`);

    // 総重量・直行率・工程内比率の算出
    const totalFailureWeight = totalDefect + totalLoss; // 直行不能重量 = 不良 + ロス
    const totalAllWeight = totalGood + totalFailureWeight; // 総重量 = 良品 + 不良 + ロス

    const directRateVal = totalAllWeight > 0 ? ((totalGood / totalAllWeight) * 100).toFixed(1) : "0.0";
    const defectRateVal = totalAllWeight > 0 ? ((totalDefect / totalAllWeight) * 100).toFixed(1) : "0.0";
    const lossRateVal = totalAllWeight > 0 ? ((totalLoss / totalAllWeight) * 100).toFixed(1) : "0.0";

    const summaryData = {
      totalGoodWeight: totalGood.toFixed(1),
      totalDefectWeight: totalDefect.toFixed(1),
      totalLossWeight: totalLoss.toFixed(1),
      totalFailureWeight: totalFailureWeight.toFixed(1),
      directRate: directRateVal + "%",
      defectRate: defectRateVal + "%",
      lossRate: lossRateVal + "%",
      worstDefects: worstDefectsList
    };

    return {
      machines: Object.values(results),
      summary: summaryData
    };

  } catch(e) {
    console.error("Ldp records fetch fatal error:", e);
    return {
      machines: Object.values(results),
      summary: { 
        totalGoodWeight: "0.0", 
        totalDefectWeight: "0.0", 
        totalLossWeight: "0.0", 
        totalFailureWeight: "0.0", 
        directRate: "0.0%", 
        defectRate: "0.0%", 
        lossRate: "0.0%", 
        worstDefects: [] 
      }
    };
  }
}

/**
 * 10. 共通関数: エラーで落ちない静かなBigQuery実行エンジン
 */
function runQuietQueryForReport_(sql, projectId) {
  if (typeof BigQuery === 'undefined') return [];
  const request = {
    query: sql,
    useLegacySql: false,
    location: APM_REP_MAIL_CONFIG.LOCATION
  };
  try {
    let queryResponse = BigQuery.Jobs.query(request, projectId);
    if (!queryResponse.jobComplete) {
      const jobId = queryResponse.jobReference.jobId;
      const jobOptions = { location: APM_REP_MAIL_CONFIG.LOCATION };
      let job = BigQuery.Jobs.get(projectId, jobId, jobOptions);
      while (job.status.state !== 'DONE') {
        Utilities.sleep(150);
        job = BigQuery.Jobs.get(projectId, jobId, jobOptions);
      }
      if (job.status.errorResult) return [];
      queryResponse = BigQuery.Jobs.getQueryResults(projectId, jobId, jobOptions);
    }
    if (!queryResponse.rows) return [];
    
    const fields = queryResponse.schema.fields;
    return queryResponse.rows.map(row => {
      const obj = {};
      row.f.forEach((cell, i) => {
        let val = cell.v;
        if (fields[i].type === 'FLOAT' || fields[i].type === 'INTEGER') {
          val = val !== null ? Number(val) : null;
        }
        obj[fields[i].name] = val;
      });
      return obj;
    });
  } catch (e) {
    console.error("Report Query Exception (Suppressed):", e);
    return [];
  }
}
/**
 * 設備稼働状況ガントチャートデータの取得 (分析対応版)
 * [特徴]
 * 1. 日またぎの状態補正: 「停止作業」から次の「金型セット」までのすべての空白を自動で埋め、停止状態を連続維持
 * 2. 8号機を 8A / 8B に完全分離・標準化
 * 3. BQリージョン指定：'asia-northeast1' でジョブ実行
 * 4. 【不具合解決】集計用に、金型セット(01)、昇温(08)、立上作業(12)、立上サイジング(13)、色替(02)を完璧に個別分離した「summaryEvents」を返却
 * 5. 【修正】「停止作業」を計画停止(PLANNED_STOP)から除外し、コード14、25を「停止・故障(STOP)」に完全統一マッピング
 */

function getOperationStatusData(startDate, endDate) {
  const projectId = 'lixil-dwh';
  const datasetId = 'pii_an1_j_tie_up_kurisawa';
  const tableTime = 'TimeResultResinTR';
  const tableNames = 'NameMS';

  const sql = `
    WITH raw_events AS (
      SELECT
        TRIM(CAST(t.EXTMachine AS STRING)) AS raw_machine,
        FORMAT_DATE('%Y-%m-%d', COALESCE(
          SAFE.PARSE_DATE('%Y/%m/%d', t.StartDate),
          SAFE.PARSE_DATE('%Y-%m-%d', t.StartDate),
          SAFE.PARSE_DATE('%Y%m%d', t.StartDate),
          SAFE.PARSE_DATE('%Y/%g/%e', t.StartDate),
          SAFE.PARSE_DATE('%Y/%g/%d', t.StartDate),
          SAFE.PARSE_DATE('%Y/%m/%e', t.StartDate)
        )) AS ext_date,
        t.StartTime AS start_time,
        TRIM(t.TimeItem) AS time_item_code,
        TRIM(n.FormalName_Kanji) AS time_item_name,
        TRIM(t.EXTIndicationNo) AS indication_no,
        COALESCE(
          SAFE.PARSE_DATE('%Y/%m/%d', t.StartDate),
          SAFE.PARSE_DATE('%Y-%m-%d', t.StartDate),
          SAFE.PARSE_DATE('%Y%m%d', t.StartDate),
          SAFE.PARSE_DATE('%Y/%g/%e', t.StartDate),
          SAFE.PARSE_DATE('%Y/%g/%d', t.StartDate),
          SAFE.PARSE_DATE('%Y/%m/%e', t.StartDate)
        ) AS parsed_date
      FROM \`${projectId}.${datasetId}.${tableTime}\` AS t
      LEFT JOIN \`${projectId}.${datasetId}.${tableNames}\` AS n
        ON TRIM(t.TimeItem) = TRIM(n.NameKey) 
        AND TRIM(n.ItemClass) = '08'
      WHERE COALESCE(
        SAFE.PARSE_DATE('%Y/%m/%d', t.StartDate),
        SAFE.PARSE_DATE('%Y-%m-%d', t.StartDate),
        SAFE.PARSE_DATE('%Y%m%d', t.StartDate),
        SAFE.PARSE_DATE('%Y/%g/%e', t.StartDate),
        SAFE.PARSE_DATE('%Y/%g/%d', t.StartDate),
        SAFE.PARSE_DATE('%Y/%m/%e', t.StartDate)
      ) BETWEEN DATE('${startDate}') AND DATE('${endDate}')
    ),
    sorted_events AS (
      SELECT
        raw_machine,
        parsed_date,
        ext_date,
        start_time,
        time_item_code,
        time_item_name,
        indication_no,
        LEAD(parsed_date) OVER(PARTITION BY raw_machine ORDER BY parsed_date ASC, start_time ASC) AS next_date,
        LEAD(start_time) OVER(PARTITION BY raw_machine ORDER BY parsed_date ASC, start_time ASC) AS next_time
      FROM raw_events
    )
    SELECT * FROM sorted_events
    WHERE ext_date IS NOT NULL
    ORDER BY parsed_date ASC, raw_machine ASC, start_time ASC
  `;

  try {
    const request = {
      query: sql,
      useLegacySql: false,
      location: 'asia-northeast1'
    };

    let queryResponse = BigQuery.Jobs.query(request, projectId);
    
    if (!queryResponse.jobComplete) {
      const jobId = queryResponse.jobReference.jobId;
      const jobOptions = { location: 'asia-northeast1' };
      let job = BigQuery.Jobs.get(projectId, jobId, jobOptions);
      while (job.status.state !== 'DONE') {
        Utilities.sleep(200);
        job = BigQuery.Jobs.get(projectId, jobId, jobOptions);
      }
      if (job.status.errorResult) {
        throw new Error(job.status.errorResult.message);
      }
      queryResponse = BigQuery.Jobs.getQueryResults(projectId, jobId, jobOptions);
    }

    const rows = queryResponse.rows;
    if (!rows) return { ganttData: [], summaryEvents: [] };

    const fields = queryResponse.schema.fields;
    const records = rows.map(row => {
      const obj = {};
      row.f.forEach((cell, i) => {
        obj[fields[i].name] = cell.v;
      });
      return obj;
    });

    return {
      ganttData: processGanttChartRecords_(records),
      summaryEvents: processSummaryEvents_(records)
    };

  } catch (e) {
    console.error("getOperationStatusData Fatal Error:", e);
    throw new Error("BigQueryからの稼働情報取得に失敗しました: " + e.toString());
  }
}

/**
 * 号機IDの揺れ（全角、前ゼロ、.0、号機表記）を完全に排除する正規化ロジック
 */
function normalizeStatusMachineId(rawId) {
  if (rawId === null || rawId === undefined) return "";
  let m = String(rawId).trim().toUpperCase();
  
  // 全角英数字を半角に標準化
  m = m.replace(/[０-９Ａ-Ｚ]/g, function(s) {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  });
  
  m = m.replace(/号機/g, "").replace(/\.0$/, "").replace(/^0+/, "");

  if (m === "8" || m === "08" || m === "8A") return "8A";
  if (m === "8B") return "8B";
  return m;
}

/**
 * 💡 大分類カテゴリ変換判定（集計サマリー専用）
 * 停止作業「14」を計画停止から完全に除外し、「14」および「25」を「STOP(赤)」にマッピングするよう修正
 */
function getSummaryCategory_(name, code) {
  const n = String(name || "");
  const c = String(code || "");

  // 1. 生産調整・計画停止 (コード14を除外し、15, 16等を割り当て)
  if (n.includes("生産調整") || n.includes("非稼働") || n.includes("計画停止") || n.includes("休み") || n.includes("時間外") || ["15", "16"].includes(c)) {
    return "PLANNED_STOP";
  }
  // 2. 停止・トラブル停止 (コード14をこちらへ追加マージ)
  if (n.includes("停止作業") || n.includes("トラブル") || n.includes("故障") || n.includes("修理") || n.includes("異常") || ["14", "25"].includes(c)) {
    return "STOP";
  }
  // 3. 押出稼働
  if (n.includes("押出") || c === "00" || n.includes("生産") || n.includes("量産")) {
    return "MOLDING";
  }
  // 4. 立上サイジング (13)
  if (n.includes("サイジング") || n.includes("ｻｲｼﾞﾝｸﾞ") || c === "13") {
    return "SIZING";
  }
  // 5. 立上作業 (12)
  if (n.includes("立上") || c === "12") {
    return "STARTUP";
  }
  // 6. 色替作業 (02)
  if (n.includes("色替") || n.includes("色替作業") || n.includes("型替") || c === "02") {
    return "COLOR_CHANGE";
  }
  // 7. 金型セット (01)
  if (n.includes("金型") || n.includes("段取") || c === "01") {
    return "DIE_SET";
  }
  // 8. 昇温 (08)
  if (n.includes("昇温") || n.includes("温調") || n.includes("加熱") || c === "08") {
    return "HEATING";
  }
  return "OTHER";
}

/**
 * 💡 改良：日またぎや細切れ分割を一切受けず、同一カテゴリが連続するイベントを結合
 */
function processSummaryEvents_(records) {
  const result = [];
  const mGroups = {};

  records.forEach(r => {
    const mId = normalizeStatusMachineId(r.raw_machine);
    if (!mId) return;
    if (!mGroups[mId]) mGroups[mId] = [];
    mGroups[mId].push(r);
  });

  Object.keys(mGroups).forEach(mId => {
    const sorted = mGroups[mId].sort((a, b) => {
      const dateA = a.parsed_date ? new Date(a.parsed_date) : new Date();
      const dateB = b.parsed_date ? new Date(b.parsed_date) : new Date();
      if (dateA.getTime() !== dateB.getTime()) return dateA.getTime() - dateB.getTime();
      return timeToMinutes_(a.start_time) - timeToMinutes_(b.start_time);
    });

    let currentEvent = null;

    sorted.forEach(r => {
      const code = r.time_item_code || "";
      const name = r.time_item_name || "その他作業ロス";
      const startLocalDate = new Date(r.parsed_date);
      const startMin = timeToMinutes_(r.start_time);

      const nextLocalDate = r.next_date ? new Date(r.next_date) : null;
      const nextMin = r.next_time ? timeToMinutes_(r.next_time) : null;

      let duration = 0;
      if (nextLocalDate && nextMin !== null) {
        const diffDays = Math.round((nextLocalDate.getTime() - startLocalDate.getTime()) / 86400000);
        duration = (diffDays * 1440) + nextMin - startMin;
      } else {
        duration = 1440 - startMin; 
      }

      if (duration <= 0) duration = 30;

      // 💡 8つの詳細カテゴリに完全マッピング
      const cat = getSummaryCategory_(name, code);

      if (currentEvent && currentEvent.Category === cat) {
        currentEvent.DurationMinutes += duration;
      } else {
        if (currentEvent) {
          result.push(currentEvent);
        }
        currentEvent = {
          MachineId: mId,
          Category: cat,
          TimeItemCode: code,
          TimeItemName: name,
          DurationMinutes: duration,
          IndicationNo: r.indication_no || ""
        };
      }
    });

    if (currentEvent) {
      result.push(currentEvent);
    }
  });

  return result;
}

/**
 * 取得データをガント表示（開始分数、継続時間）にマッピング
 */
function processGanttChartRecords_(records) {
  const result = [];

  records.forEach(r => {
    const mId = normalizeStatusMachineId(r.raw_machine);
    if (!mId) return;

    const startLocalDate = new Date(r.parsed_date);
    const startMin = timeToMinutes_(r.start_time);
    
    const nextLocalDate = r.next_date ? new Date(r.next_date) : null;
    const nextMin = r.next_time ? timeToMinutes_(r.next_time) : null;

    if (!nextLocalDate) {
      const duration = 1440 - startMin;
      if (duration > 0) {
        result.push({
          EXTDate: Utilities.formatDate(startLocalDate, "JST", "yyyy-MM-dd"),
          MachineId: mId,
          StartTime: r.start_time,
          EndTime: "24:00",
          StartMinutes: startMin,
          DurationMinutes: duration,
          TimeItemCode: r.time_item_code || "",
          TimeItemName: r.time_item_name || "その他作業ロス",
          IndicationNo: r.indication_no || ""
        });
      }
      return;
    }

    let currentLocalDate = new Date(startLocalDate.getTime());
    while (currentLocalDate <= nextLocalDate) {
      const currentDateStr = Utilities.formatDate(currentLocalDate, "JST", "yyyy-MM-dd");
      const nextDateStr = Utilities.formatDate(nextLocalDate, "JST", "yyyy-MM-dd");

      let currentStartMin = 0;
      let currentEndMin = 1440;
      let currentStartTimeStr = "00:00";
      let currentEndTimeStr = "24:00";

      if (currentDateStr === Utilities.formatDate(startLocalDate, "JST", "yyyy-MM-dd")) {
        currentStartMin = startMin;
        currentStartTimeStr = r.start_time;
      }

      if (currentDateStr === nextDateStr) {
        currentEndMin = nextMin;
        currentEndTimeStr = r.next_time;
      }

      const duration = currentEndMin - currentStartMin;
      if (duration > 0) {
        result.push({
          EXTDate: currentDateStr,
          MachineId: mId,
          StartTime: currentStartTimeStr,
          EndTime: currentEndTimeStr,
          StartMinutes: currentStartMin,
          DurationMinutes: duration,
          TimeItemCode: r.time_item_code || "",
          TimeItemName: r.time_item_name || "その他作業ロス",
          IndicationNo: r.indication_no || ""
        });
      }

      currentLocalDate.setDate(currentLocalDate.getDate() + 1);
    }
  });

  return result;
}

/**
 * 時刻フォーマット「HH:mm」または「HH:mm:ss」を分単位にパース
 */
function timeToMinutes_(timeStr) {
  if (!timeStr) return 0;
  const p = timeStr.split(':');
  if (p.length < 2) return 0;
  const h = parseInt(p[0], 10) || 0;
  const m = parseInt(p[1], 10) || 0;
  return (h * 60) + m;
}
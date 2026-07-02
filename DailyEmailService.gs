/**
 * 【重要】トリガー設定時は「daily_sendReport」という関数名を選択してください。
 */

function daily_sendReport() {
  try {
    // --- 【設定項目：ここを修正してください】 ---
    // 1. ポータルのURL：デプロイ画面で発行された「ウェブアプリのURL（末尾が /exec のもの）」をここに貼り付けてください。
    const PORTAL_URL = 'https://script.google.com/a/macros/lixil.com/s/AKfycbxPxwH9-qgbG_Vrbm6z3GvOWvg2UwzW2f0eEo8apCfC8pu9sh_RiLcKJOvnAvlV7xAW/exec'; 

    const recipients = [
      "takashi.hashizume@lixil.com", "kinji.nakao@lixil.com", "takashi.nojiri@lixil.com",
      "tetuya.saitou@lixil.com", "takuo.honma@lixil.com", "hirotugu.ogawara@lixil.com",
      "y7.hayashi@lixil.com", "masahiro.sakabe@lixil.com", "kaito.nakagawa@lixil.com",
      "kimie.nakai@lixil.com", "norihiro.tanimoto@lixil.com", "jinya.igarashi@lixil.com",
      "daiki.sunahara@lixil.com", "masaru.sotoyama@lixil.com", "tomohiro.aoki@lixil.com",
      "keiiti.fujita@lixil.com", "shinsuke.sawada@lixil.com","ryouta.tanimoto@lixil.com",
      "takehiko.makuzawa@lixil.com ","mayu1.suzuki@lixil.com"
    ].join(",");
    // ------------------------------------------

    const today = new Date();
    // 週末（土日）はスキップ
    if (today.getDay() === 0 || today.getDay() === 6) return console.log("週末スキップ");

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const monthStr = Utilities.formatDate(yesterday, "JST", "yyyy-MM");
    const dateStr = Utilities.formatDate(yesterday, "JST", "yyyy/MM/dd");
    const displayDate = Utilities.formatDate(yesterday, "JST", "M月d日");

    // LDPデータの取得（リトライ処理付き）
    let allData = null;
    let maxRetries = 6;
    let retryCount = 0;
    while (retryCount < maxRetries) {
      try {
        allData = getMonthlyData(monthStr); 
        if (allData && allData.oshiji && allData.oshiji.length > 0) break;
        throw new Error("Empty");
      } catch (e) {
        retryCount++;
        if (retryCount >= maxRetries) throw new Error("LDP取得エラー");
        Utilities.sleep(retryCount * 5000); 
      }
    }
    
    // 当日分のデータ抽出
    const dailyOshiji = allData.oshiji.filter(r => (r["押出日付"] || "").replace(/-/g, '/') === dateStr);
    const dailyFuryouji = allData.furyouji.filter(r => (r["押出日付"] || "").replace(/-/g, '/') === dateStr);

    if (dailyOshiji.length === 0 && dailyFuryouji.length === 0) return console.log("データ未反映");

    // 月次累計分のデータ抽出（月初〜当日まで）
    const monthlyOshiji = allData.oshiji.filter(r => (r["押出日付"] || "").replace(/-/g, '/') <= dateStr);
    const monthlyFuryouji = allData.furyouji.filter(r => (r["押出日付"] || "").replace(/-/g, '/') <= dateStr);

    // 各集計の実行
    const stats = daily_calculateStats(dailyOshiji, dailyFuryouji);
    const mStats = daily_calculateStats(monthlyOshiji, monthlyFuryouji);
    
    // 累計直行率をstatsオブジェクトに追加
    stats.monthlyYieldRate = mStats.yieldRate;

    const subject = `${displayDate} 押出実績（LIXIL 栗沢工場）`;
    const htmlBody = daily_createBody(displayDate, stats, PORTAL_URL);

    MailApp.sendEmail({
      to: recipients,
      subject: subject,
      htmlBody: htmlBody
    });

    console.log("配信成功");

  } catch (err) {
    console.error("重大なエラー: " + err.message);
  }
}

/**
 * 実績集計（直情報を除外）
 */
function daily_calculateStats(oshiji, furyouji) {
  let tg = 0, tb = 0;
  oshiji.forEach(row => {
    const pcs = parseFloat(row["積載本数"]) || 0;
    const unitW = parseFloat(row["単重"]) || 0;
    const length = parseFloat(row["定尺"]) || 0;
    tg += (pcs * unitW * length) / 1000;
  });
  const defectDetails = [];
  furyouji.forEach(row => {
    const badW = (parseFloat(row["再生重量"]) || 0) + (parseFloat(row["廃棄重量"]) || 0);
    tb += badW;
    let mod = String(row["型番"] || "").trim();
    defectDetails.push({
      machine: (String(row["号機"]) || "-").replace(/^0+/, '') + "号機",
      model: mod.toUpperCase().startsWith("PA") ? mod : "PA" + mod,
      name: row["不良名称"] || "-",
      weight: badW
    });
  });
  const top3 = defectDetails.sort((a, b) => b.weight - a.weight).slice(0, 3);
  return { 
    yieldRate: (tg + tb > 0) ? (tg / (tg + tb) * 100).toFixed(1) : "0.0", 
    totalGoodWeight: Math.round(tg).toLocaleString(), 
    totalBadWeight: Math.round(tb).toLocaleString(),
    top3: top3 
  };
}

/**
 * HTMLメール本文
 */
function daily_createBody(displayDate, s, appUrl) {
  let topRows = s.top3.map((d, i) => {
    return `${i + 1}位 <b>${d.machine}</b> [${d.model}] <span style="color:#ef4444">${d.weight.toFixed(1)}kg</span> (${d.name})`;
  }).join("<br>");
  
  if (s.top3.length === 0) topRows = "なし";

  return `
    <div style="font-family:sans-serif; border:1px solid #e2e8f0; padding:25px; border-radius:12px; color:#334155; max-width:600px;">
      <h2 style="color:#F60; border-bottom:2px solid #F60; padding-bottom:10px; margin-top:0;">栗沢工場 押出実績（${displayDate}）</h2>
      
      <p style="margin-bottom:20px;">お疲れ様です。前日の押出実績を配信します。</p>
      
      <div style="background:#f8fafc; padding:20px; border-radius:8px; margin:20px 0;">
        <table style="width:100%; margin-bottom:15px; border-collapse: collapse;">
          <tr>
            <td style="width:48%; vertical-align: top;">
              <div style="font-size:12px; color:#64748b; font-weight:bold; margin-bottom:5px;">当日直行率</div>
              <div style="font-size:32px; font-weight:bold; color:#F60;">${s.yieldRate}%</div>
            </td>
            <td style="width:4%; border-left:1px solid #e2e8f0;"></td>
            <td style="width:48%; vertical-align: top; padding-left:10px;">
              <div style="font-size:12px; color:#64748b; font-weight:bold; margin-bottom:5px;">月次累計直行率</div>
              <div style="font-size:32px; font-weight:bold; color:#3b82f6;">${s.monthlyYieldRate}%</div>
            </td>
          </tr>
        </table>
        
        <table style="width:100%; border-top:1px solid #e2e8f0; padding-top:10px;">
          <tr>
            <td style="font-size:14px; color:#64748b;">生産重量 (良品)</td>
            <td style="text-align:right; font-weight:bold; font-size:15px;">${s.totalGoodWeight} <span style="font-size:11px; font-weight:normal;">kg</span></td>
          </tr>
          <tr>
            <td style="font-size:14px; color:#64748b;">不良ロス重量</td>
            <td style="text-align:right; font-weight:bold; font-size:15px; color:#ef4444;">${s.totalBadWeight} <span style="font-size:11px; font-weight:normal;">kg</span></td>
          </tr>
        </table>
      </div>

      <div style="margin-bottom:25px;">
        <p style="font-weight:bold; color:#1e293b; margin-bottom:10px; font-size:14px; border-left:4px solid #ef4444; padding-left:10px;">重量ワースト不良</p>
        <div style="padding-left:14px; font-size:14px; line-height:1.8;">
          ${topRows}
        </div>
      </div>

      <p style="font-size:12px; color:#1e293b; margin-top:30px; font-weight:bold;">
        ポータル内のサイドメニュー、「押出実績分析」からご確認いただけます。
        SYNCボタンを押して、LDPから実績を読み取ってください。
      </p>

      <div style="text-align:center; margin-top:20px;">
        <a href="${appUrl}" style="background:#1e293b; color:#fff; padding:12px 25px; text-decoration:none; border-radius:8px; font-weight:bold; font-size:14px; display: inline-block;">ポータルを確認する</a>
      </div>
    </div>`;
}

/**
 * 承認用
 */
function daily_forceAuth() {
  const me = Session.getActiveUser().getEmail();
  MailApp.sendEmail(me, "承認テスト", "完了");
}
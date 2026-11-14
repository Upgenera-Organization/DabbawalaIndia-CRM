/**
 * DABBAWALA INDIA — DELIVERY BOY APP
 * Bound Apps Script project. Reads CUSTOMER, ROUTE, DEMO, Deliveries,
 * CUSTOMER_REQUESTS and DeliveryBoys sheets from the spreadsheet.
 *
 * SECURITY: DeliveryBoys must contain a DeliveryBoyID column and a Password/PIN
 * column. Do not remove server-side login validation.
 *
 * NEW in this version
 *  - markDelivered / markNotAvailable  -> writes a row to the Deliveries sheet
 *  - addDeliveryNote                   -> saves optional note (if a Notes/Remark column exists)
 *  - checkIn                           -> writes to a "CheckIns" sheet (auto-created)
 *  - totals.emptyBoxes / totals.incentive returned to the Home & Report screens
 *  - login brute-force limit (5 wrong attempts = 15 min lock per ID)
 */
const APP_CFG = {
  SPREADSHEET_ID: '1i7OnkU5xJiDYYZuS8j58PZBj2z0iEExYPQAmMAnvcKs',
  SHEETS: {
    customers: 'CUSTOMER',
    route: 'ROUTE',
    demo: 'DEMO',
    deliveries: 'Deliveries',
    requests: 'CUSTOMER_REQUESTS',
    boys: 'DeliveryBoys',
    checkins: 'CheckIns',
    live: 'LIVE_LOCATIONS',        // existing sheet: DeliveryBoyID | DeliveryBoyNAME | MAIL | Location | LastUpdated (extra columns are added automatically)
    box: 'BOX',                    // empty-box ledger: boxes that are with customers
    attendance: '',                // optional: exact tab name of the attendance sheet; blank = found automatically by its LunchCheckIn/DinnerCheckIn headers
    history: 'LocationHistory',    // breadcrumb log, one row every ~2 minutes (auto-created)
    settings: 'Settings1'          // shift timings, punch-in deadlines, week off and payment QR image
  },
  TIMEZONE: 'Asia/Kolkata',
  USE_ROUTE_SHEET: false,          // false = customers, boys and route order come from the CUSTOMER sheet (DeliveryBoyID + LunchRouteOrder / DinnerRouteOrder). true = use the ROUTE sheet first.
  DINNER_FROM_MINUTES: 16*60+30,   // 16:30 onwards = DINNER only, before 16:30 = LUNCH only
  SESSION_SECONDS: 21600,
  // Punch-in deadlines (lunch 09:30, dinner 17:30) and shift timings now come from the Settings1 sheet - see SHIFT_DEFAULTS_ below.
  INCENTIVE_PER_DELIVERY: 10   // ₹ per fully completed customer stop. Change to your rule.
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Dabbawala India | Delivery Partner')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* ---------- Authentication ---------- */
function loginDeliveryBoy(deliveryBoyId, password) {
  const id = clean_(deliveryBoyId).toUpperCase();
  const pass = String(password || '');
  if (!id || !pass) return { ok:false, message:'Enter Delivery Boy ID and password.' };

  const cache = CacheService.getScriptCache();
  const failKey = 'db_fail_' + id;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) return { ok:false, message:'Too many wrong attempts. Try again in 15 minutes.' };

  const sh = getSheet_(APP_CFG.SHEETS.boys);
  if (!sh) return { ok:false, message:'DeliveryBoys sheet was not found. Please ask the administrator to configure delivery-boy login.' };
  const t = readTable_(sh);
  const cId = col_(t.headers, ['DeliveryBoyID','Delivery Boy ID','Boy ID','Agent ID','Employee ID']);
  const cPass = col_(t.headers, ['Password','PIN','Passcode','Login Password']);
  const cName = col_(t.headers, ['Name','DeliveryBoyName','Delivery Boy Name','Employee Name']);
  const cArea = col_(t.headers, ['Area','Location','Zone']);
  const cStatus = col_(t.headers, ['Status','Active','EmployeeStatus']);
  const cUpi = col_(t.headers, ['UPI','UPI ID','UPIID','Payment UPI','VPA','UPI Address']);
  if (cId < 0 || cPass < 0) return { ok:false, message:'DeliveryBoys sheet needs DeliveryBoyID and Password/PIN columns.' };

  const row = t.rows.find(r => clean_(r[cId]).toUpperCase() === id && String(r[cPass] || '') === pass);
  if (!row) {
    cache.put(failKey, String(fails + 1), 900);
    return { ok:false, message:'Invalid Delivery Boy ID or password.' };
  }
  if (cStatus >= 0 && /^(inactive|disabled|no|false)$/i.test(clean_(row[cStatus]))) {
    return { ok:false, message:'This delivery-boy account is inactive. Contact the administrator.' };
  }

  cache.remove(failKey);
  const token = Utilities.getUuid() + Utilities.getUuid();
  const profile = { id:id, name:cName >= 0 ? clean_(row[cName]) : id, area:cArea >= 0 ? clean_(row[cArea]) : '', upi:cUpi >= 0 ? clean_(row[cUpi]) : '' };
  cache.put('db_session_' + token, JSON.stringify(profile), APP_CFG.SESSION_SECONDS);
  return { ok:true, token:token, profile:profile };
}

function logoutDeliveryBoy(token) {
  try { const p = session_(token); if (p) upsertLive_(p, null, null, null, 'Offline'); } catch(e) {}
  if (token) CacheService.getScriptCache().remove('db_session_' + String(token));
  return { ok:true };
}

// REGULAR / CUSTOMIZED / DEMO from the CUSTOMER sheet's Order Type (falls back to the route type, then Meal Type)
function orderLabel_(x) {
  const src = [x.orderType, x.type, x.mealType].map(clean_).filter(Boolean)[0] || '';
  if (/CUSTOM/i.test(src)) return 'CUSTOMIZED';
  if (/DEMO|TRIAL/i.test(src)) return 'DEMO';
  return 'REGULAR';
}

function getMyDeliveryData(token, requestedDate, meal) {
  const profile = session_(token);
  if (!profile) throw new Error('Your session has expired. Please log in again.');
  const target = parseDateKey_(requestedDate) || dateKey_(new Date());
  // Today: the meal is decided by the clock (before 16:30 = LUNCH, 16:30-23:59 = DINNER). Other dates honour the request.
  const isToday = target === Utilities.formatDate(new Date(), APP_CFG.TIMEZONE, 'yyyy-MM-dd');
  const selectedMeal = isToday ? currentMeal_() : normalizeMeal_(meal || 'ALL');

  const boyInfo = boyScheduleInfo_(profile);
  const customerTable = table_(APP_CFG.SHEETS.customers);
  const routeTable = table_(APP_CFG.SHEETS.route);
  const demoTable = table_(APP_CFG.SHEETS.demo);
  const deliveryTable = table_(APP_CFG.SHEETS.deliveries);
  const requestTable = table_(APP_CFG.SHEETS.requests);

  const C = customerColumns_(customerTable.headers);
  const R = routeColumns_(routeTable.headers);
  const D = deliveryColumns_(deliveryTable.headers);
  const Q = requestColumns_(requestTable.headers);

  const customersById = {};
  customerTable.rows.forEach(r => {
    const id = val_(r, C.id);
    if (id) customersById[id.toUpperCase()] = customerObject_(r, C);
  });

  const requestsByCustomerMeal = buildRequests_(requestTable, Q, target);
  const deliveryByCustomerMeal = buildDeliveryMap_(deliveryTable, D, target, customersById);

  // Prefer ROUTE for the selected date and boy. This carries route order and supports
  // temporary/demo route entries. If ROUTE has no matching rows, use CUSTOMER master
  // assignments as a safe fallback.
  let items = [];
  const routeRows = !APP_CFG.USE_ROUTE_SHEET ? [] : routeTable.rows.filter(r => {
    const boy = val_(r, R.boy).toUpperCase();
    const rowDate = dateKeyFromCell_(val_(r, R.date));
    const rowMeal = normalizeMeal_(val_(r, R.meal));
    return boy === profile.id && rowDate === target &&
      (selectedMeal === 'ALL' || rowMeal === selectedMeal);
  });

  routeRows.forEach(r => {
    const cid = val_(r, R.cid).toUpperCase();
    const base0 = customersById[cid] || routeCustomerObject_(r, R, cid);
    if (!base0 || !base0.customerId) return;
    const mealName = normalizeMeal_(val_(r, R.meal));
    const base = customersById[cid] ? forMeal_(base0, mealName) : base0;
    const req = requestsByCustomerMeal[key_(base.customerId, mealName)] || emptyRequest_();
    if (req.cancelled) return;
    const delivery = deliveryByCustomerMeal[key_(base.customerId, mealName)] || {};
    const routeQty = num_(val_(r, R.qty));
    const masterQty = mealName === 'DINNER' ? num_(base.dinnerQty) : num_(base.lunchQty);
    const required = Math.max(0, (routeQty || masterQty) + req.extraQty - req.cancelQty);
    items.push(mergeItem_(base, {
      meal:mealName, routeOrder:val_(r,R.order), type:val_(r,R.type) || base.orderType,
      requiredQty:required, extraQty:req.extraQty, cancelQty:req.cancelQty,
      deliveredQty:delivery.deliveredQty || 0, remainingQty:Math.max(0, required - (delivery.deliveredQty || 0)),
      deliveryStatus:delivery.status || '', deliveryId:delivery.deliveryId || '',
      requestNote:req.note || ''
    }));
  });

  // CUSTOMER sheet: every customer assigned to THIS delivery boy (LunchDeliveryBoyID / DinnerDeliveryBoyID, else DeliveryBoyID).
  // LUNCH stops use LunchRouteOrder, DINNER stops use DinnerRouteOrder.
  if (!items.length) {
    customerTable.rows.forEach(r => {
      const c = customerObject_(r, C);
      if (!c.customerId) return;
      ['LUNCH','DINNER'].forEach(m => {
        const cm = forMeal_(c, m);
        const eff = effectiveBoy_(cm);
        if (eff.id !== String(profile.id).toUpperCase()) return;
        cm.isBackup = !!eff.backupOf; cm.backupOf = eff.backupOf;
        if (selectedMeal !== 'ALL' && selectedMeal !== m) return;
        if (!mealEnabled_(m === 'LUNCH' ? val_(r,C.lunchQty) : val_(r,C.dinnerQty))) return;
        if (isCustomerOffToday_(cm.weekOff, target)) return;                  // customer's own week-off for this shift
        const req = requestsByCustomerMeal[key_(c.customerId,m)] || emptyRequest_();
        if (req.cancelled) return;
        const del = deliveryByCustomerMeal[key_(c.customerId,m)] || {};
        const qty = num_(m === 'LUNCH' ? c.lunchQty : c.dinnerQty);
        items.push(mergeItem_(cm,{meal:m,routeOrder:cm.routeOrder,
          type:cm.orderType,requiredQty:Math.max(0,qty+req.extraQty-req.cancelQty),
          extraQty:req.extraQty,cancelQty:req.cancelQty,deliveredQty:del.deliveredQty||0,
          remainingQty:Math.max(0,qty+req.extraQty-req.cancelQty-(del.deliveredQty||0)),
          deliveryStatus:del.status||'',deliveryId:del.deliveryId||'',requestNote:req.note||''}));
      });
    });
  }
  // DEMO sheet: rows whose Date + Meal match are added to the customer list - only when "Show Demo" is ticked for this boy in DeliveryBoys.
  if (boyInfo.showDemo) addDemoItems_(items, demoTable, profile.id, target, selectedMeal, requestsByCustomerMeal, deliveryByCustomerMeal);

  items = dedupeItems_(items);
  // Delivery boys with "Show Customer" ticked in the DeliveryBoys sheet can also pick ANY other customer in Quick Scan.
  const allCustomers = [];
  if (boyInfo.showAll) {
    const mine = {}; items.forEach(x => { mine[key_(x.customerId, x.meal)] = 1; });
    customerTable.rows.forEach(r => {
      const c = customerObject_(r, C); if (!c.customerId) return;
      ['LUNCH','DINNER'].forEach(m => {
        if (selectedMeal !== 'ALL' && selectedMeal !== m) return;
        if (mine[key_(c.customerId, m)]) return;
        if (isCustomerOffToday_(forMeal_(c, m).weekOff, target)) return;
        if (!mealEnabled_(m === 'LUNCH' ? val_(r,C.lunchQty) : val_(r,C.dinnerQty))) return;
        const req = requestsByCustomerMeal[key_(c.customerId,m)] || emptyRequest_();
        if (req.cancelled) return;
        const del = deliveryByCustomerMeal[key_(c.customerId,m)] || {};
        const qty = num_(m === 'LUNCH' ? c.lunchQty : c.dinnerQty), need = Math.max(0, qty + req.extraQty - req.cancelQty), left = Math.max(0, need - (del.deliveredQty || 0));
        if (left <= 0) return;
        const x = mergeItem_(forMeal_(c, m), { meal:m, routeOrder:'', type:forMeal_(c, m).orderType, requiredQty:need, extraQty:req.extraQty, cancelQty:req.cancelQty,
          deliveredQty:del.deliveredQty || 0, remainingQty:left, deliveryStatus:del.status || '', deliveryId:del.deliveryId || '', requestNote:req.note || '' });
        x.mealTypeLabel = orderLabel_(x); x.otherRoute = true; allCustomers.push(x);
      });
    });
    allCustomers.sort((a,b) => String(a.customerName).localeCompare(String(b.customerName)));
  }
  // Route order for the CURRENT SHIFT only: LunchRouteOrder (lunch) / DinnerRouteOrder (dinner), or the order typed for today's date + shift in the ROUTE sheet.
  const ovr = routeOrderOverrides_(routeTable, R, target);
  items.forEach(x => { const o = ovr[key_(x.customerId, x.meal)]; if (o !== undefined) x.routeOrder = o; });
  items.sort((a,b) => numberSort_(a.routeOrder) - numberSort_(b.routeOrder) ||
    String(a.customerName).localeCompare(String(b.customerName)));
  items.forEach(x => { x.mealTypeLabel = orderLabel_(x); });
  const totals = items.reduce((s,x) => {
    s.customers++; s.required += x.requiredQty; s.delivered += x.deliveredQty;
    s.pending += x.remainingQty;
    if (x.requiredQty > 0 && x.remainingQty === 0) s.completed++;
    if (x.meal === 'LUNCH') s.lunch++; else if (x.meal === 'DINNER') s.dinner++;
    if (x.mealTypeLabel === 'CUSTOMIZED') s.customized += x.requiredQty; else if (x.mealTypeLabel === 'DEMO') s.demo += x.requiredQty; else s.regular += x.requiredQty;   // CUSTOMER sheet > Order Type
    return s;
  }, {customers:0,required:0,delivered:0,pending:0,completed:0,lunch:0,dinner:0,regular:0,customized:0,demo:0});
  totals.demo = 0;                                                        // Demo card = number of demo entries in the DEMO sheet for this date (both meals)
  if (boyInfo.showDemo) { try { demoRows_(demoTable, profile.id, target).forEach(d => { totals.demo += d.meals.length; }); } catch (e) {} }
  totals.emptyBoxes = totals.delivered;                                   // fallback when the BOX sheet is missing
  try { const bx = getBoxData_(profile); if (bx.found && bx.recognized) totals.emptyBoxes = bx.total; } catch (e) {}
  totals.incentive = totals.completed * APP_CFG.INCENTIVE_PER_DELIVERY;   // ₹
  return { ok:true, profile:profile, date:target, meal:selectedMeal, currentMeal:currentMeal_(), isToday:isToday, items:items, allCustomers:allCustomers, showAll:!!boyInfo.showAll, showDemo:!!boyInfo.showDemo, totals:totals,
    generatedAt:Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMM yyyy, hh:mm a') };
}

/* ---------- Write actions ---------- */
function markDelivered(token, payload) {
  return recordDelivery_(token, payload, false);
}

function markNotAvailable(token, payload) {
  return recordDelivery_(token, payload, true);
}

function recordDelivery_(token, payload, notAvailable) {
  const profile = session_(token);
  if (!profile) return { ok:false, message:'Your session has expired. Please log in again.' };
  payload = payload || {};
  const date = parseDateKey_(payload.date) || dateKey_(new Date());
  const meal = normalizeMeal_(payload.meal);
  const cid = clean_(payload.customerId).toUpperCase();
  if (!cid || (meal !== 'LUNCH' && meal !== 'DINNER')) return { ok:false, message:'Invalid delivery request.' };

  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { return { ok:false, message:'Server is busy. Please try again.' }; }
  try {
    // Re-derive the list on the server so a boy can only mark HIS OWN stops.
    const data = getMyDeliveryData(token, date, meal);
    const item = data.items.find(x => String(x.customerId).toUpperCase() === cid && x.meal === meal) ||
                 (data.allCustomers || []).find(x => String(x.customerId).toUpperCase() === cid && x.meal === meal);   // allowed only when "Show Customer" is ticked for this boy
    if (!item) return { ok:false, message:'This customer is not on your route for the selected date.' };
    if (!notAvailable && item.remainingQty <= 0) return { ok:false, message:'Already delivered.' };

    // Optional box scan: validate the box before anything is written.
    const isDemo = item.mealTypeLabel === 'DEMO' || item.type === 'DEMO';
    const noBoxGiven = !notAvailable && !clean_(payload.boxId);                 // delivered without a box -> disposable thali
    let boxId = (!notAvailable && (isDemo || noBoxGiven)) ? 'DISPOSABLE THALI' : '', boxInfo = null;     // demo tiffins go in a disposable thali: no box lookup
    if (!notAvailable && !isDemo && !noBoxGiven) {
      boxInfo = lookupBox_(profile, payload.boxId);
      boxId = boxInfo.boxId;
      if (!boxInfo.found) return { ok:false, message:'Box ' + boxId + ' was not found in the BOX sheet. No delivery was saved.' };
      if (boxInfo.status !== 'AVAILABLE') return { ok:false, message:'Box ' + boxId + ' is not available (current status: ' + boxInfo.status + '). Return it first before delivering it again.' };
    }

    const sh = getSheet_(APP_CFG.SHEETS.deliveries);
    if (!sh) return { ok:false, message:'Deliveries sheet not found.' };
    const t = readTable_(sh);
    const h = t.headers;
    const D = deliveryColumns_(h);
    const now = new Date();
    const tz = Session.getScriptTimeZone();
    const deliveryId = Utilities.getUuid().replace(/-/g, '').slice(0, 8);      // same short style as existing rows
    let qty = notAvailable ? 0 : 1;
    if (isDemo && !notAvailable) {                                           // demo: the boy picks how many tiffins, never more than ordered
      const asked = Math.floor(Number(payload.qty));
      qty = asked >= 1 ? asked : Math.max(1, item.remainingQty);
      if (qty > item.remainingQty) return { ok:false, message:'Only ' + item.remainingQty + ' demo tiffin(s) remaining. Quantity cannot be more than ordered.' };
    }
                                          // ONE tiffin per save (one box = one tiffin)
    const note = clean_(payload.note).slice(0, 300);
    const remark = notAvailable ? ('NOT AVAILABLE' + (note ? ' - ' + note : '')) : (isDemo ? ('DEMO' + (note ? ' - ' + note : '')) : note);

    if (boxId && boxId !== 'DISPOSABLE THALI' && D.box >= 0) {                                              // same box must not be booked twice for this customer/meal/day
      const key = boxKey_(boxId), cust = String(item.customerId).toUpperCase();
      const dup = t.rows.some(r => boxKey_(val_(r, D.box)) === key && dateKeyFromCell_(val_(r, D.date)) === date &&
        normalizeMeal_(val_(r, D.meal)) === meal && (val_(r, D.customer).toUpperCase() === cust));
      if (dup) return { ok:false, message:'Box ' + boxId + ' is already marked delivered for this customer.' };
    }

    // Write exactly like the rows already in the sheet: same columns, same value types, same formats. No new columns.
    const lastRow = sh.getLastRow(), newRow = lastRow + 1, width = Math.max(h.length, 1);
    const sample = lastRow >= 2 ? sh.getRange(lastRow, 1, 1, width).getValues()[0] : [];
    const asDate = i => i >= 0 && sample[i] instanceof Date;
    const row = new Array(width).fill('');
    const put = (i, v) => { if (i >= 0) row[i] = v; };
    put(D.id, deliveryId);
    put(D.box, boxId);
    put(D.customer, item.customerId);
    put(D.note, remark);
    put(D.time, asDate(D.time) ? now : Utilities.formatDate(now, tz, 'dd/MM/yyyy HH:mm:ss'));
    put(D.date, asDate(D.date) ? Utilities.parseDate(date, tz, 'yyyy-MM-dd') : Utilities.formatDate(Utilities.parseDate(date, tz, 'yyyy-MM-dd'), tz, 'dd/MM/yyyy'));
    put(D.meal, meal);
    put(D.required, item.requiredQty);
    put(D.delivered, qty);
    put(D.remaining, notAvailable ? item.remainingQty : Math.max(0, item.remainingQty - qty));
    put(D.status, notAvailable ? 'Not Available' : 'Delivered');          // only if the sheet already has a Status column
    put(D.boy, profile.id);
    put(D.deliveredBy, profile.id);
    if (lastRow >= 2) sh.getRange(lastRow, 1, 1, width).copyTo(sh.getRange(newRow, 1, 1, width), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    sh.getRange(newRow, 1, 1, width).setValues([row]);
    SpreadsheetApp.flush();

    let boxUpdated = false;
    if (boxId && boxId !== 'DISPOSABLE THALI' && !notAvailable) { try { boxUpdated = assignBoxToCustomer_(boxId, item, profile, date, meal); } catch (e) {} }
    let held = []; try { held = customerBoxIds_(item.customerId); } catch (e) {}
    return { ok:true, deliveryId:deliveryId, qty:qty, boxId:boxId, boxUpdated:boxUpdated, boxesWithCustomer:held.length, heldBoxIds:held,
      requiredQty:item.requiredQty, deliveredTotal:(item.deliveredQty || 0) + qty, remainingAfter:Math.max(0, item.remainingQty - qty),
      isDemo:!!isDemo, paymentPending:isDemo && payState_(item.payment) !== 'PAID', customerId:item.customerId, customerName:item.customerName || item.customerId,
      meal:meal, paymentAmount:num_(item.paymentAmount),
      time:Utilities.formatDate(now, tz, 'hh:mm a'), date:Utilities.formatDate(now, tz, 'dd MMM yyyy') };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Demo payment collection + photo proof ---------- */
function collectDemoPayment(token, payload) {
  const profile = session_(token);
  if (!profile) return {ok:false, message:'Your session has expired. Please log in again.'};
  payload = payload || {};
  const cid = clean_(payload.customerId).toUpperCase(), meal = normalizeMeal_(payload.meal);
  const date = parseDateKey_(payload.date) || dateKey_(new Date());
  const amount = num_(payload.amount), mode = clean_(payload.mode).toUpperCase();
  const dataUrl = String(payload.photoData || '');
  if (!cid || !['LUNCH','DINNER'].includes(meal)) return {ok:false,message:'Invalid demo payment.'};
  if (!(amount > 0)) return {ok:false,message:'Enter the amount collected.'};
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(dataUrl)) return {ok:false,message:'Please take or select a payment photo.'};
  if (dataUrl.length > 11000000) return {ok:false,message:'Photo is too large. Please take a smaller photo.'};
  if (!['CASH','UPI','ONLINE','OTHER'].includes(mode)) return {ok:false,message:'Select a payment mode.'};

  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch(e) { return {ok:false,message:'Server is busy. Please try again.'}; }
  try {
    // Verify against the saved Deliveries sheet directly. Do not call getMyDeliveryData()
    // here: for today's date that function intentionally forces the current clock shift,
    // which can reject a valid demo payment for the other shift.
    const deliveryTable = table_(APP_CFG.SHEETS.deliveries);
    const deliveryMap = buildDeliveryMap_(deliveryTable, deliveryColumns_(deliveryTable.headers), date, {});
    const savedDelivery = deliveryMap[key_(cid, meal)] || {};
    if (Number(savedDelivery.deliveredQty || 0) <= 0) {
      return {ok:false,message:'Mark this demo delivery as delivered before collecting payment.'};
    }
    const dt = table_(APP_CFG.SHEETS.demo), h = dt.headers;
    if (!h.length) return {ok:false,message:'DEMO sheet not found.'};
    const dc = {
      date:col_(h,['Date','Demo Date','DemoDate','Delivery Date','Trial Date']),
      cid:col_(h,['CustomerID','Customer ID','Cust ID','DemoID','Demo ID']),
      name:col_(h,['CustomerName','Customer Name','Demo Customer','Demo Customer Name','DemoCustomer','Name','Customer','Demo Name','Name of Customer','Party Name','Lead Name']),
      meal:col_(h,['Meal','Meal Type','MealType','Shift','Demo Meal','Demo Shift']),
      pay:col_(h,['Demo Payment Status','DemoPaymentStatus','Payment Status','PaymentStatus','Pay Status','Payment','Payment Received','Paid','Paid Status']),
     amount:col_(h,['Amount','Demo Amount','Payment Amount','Fees','Total Amount','Amount Due'])
    };
    const sheet = getSheet_(APP_CFG.SHEETS.demo);
    const values = sheet.getDataRange().getValues();
    let demoRow = -1, customerName = clean_(payload.customerName) || cid;
    for (let i=1;i<values.length;i++) {
      const row = values[i];
      const rowId = (dc.cid>=0 ? clean_(row[dc.cid]) : '').toUpperCase();
      const rowName = dc.name>=0 ? clean_(row[dc.name]) : '';
      if ((rowId === cid || (!rowId && rowName.toUpperCase() === cid)) &&
          (dc.date<0 || dateKeyFromCell_(row[dc.date]) === date) &&
          (dc.meal<0 || !normalizeMeal_(row[dc.meal]) || normalizeMeal_(row[dc.meal]) === 'ALL' || normalizeMeal_(row[dc.meal]) === meal)) {
        demoRow=i+1; customerName=rowName || customerName; break;
      }
    }
    if (demoRow < 0) return {ok:false,message:'Matching customer was not found in the DEMO sheet.'};
    if (dc.pay < 0) {
      dc.pay = h.length;
      sheet.getRange(1,dc.pay+1).setValue('Demo Payment Status');
      h.push('Demo Payment Status');
    }
    const existingStatus = clean_(sheet.getRange(demoRow,dc.pay+1).getValue());
    if (payState_(existingStatus) === 'PAID') return {ok:false,message:'This demo payment is already marked as PAID.'};

    const m = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,([\s\S]+)$/i);
    const ext = m[1].toLowerCase()==='jpeg' ? 'jpg' : m[1].toLowerCase();
    const bytes = Utilities.base64Decode(m[2]);
    const blob = Utilities.newBlob(bytes, 'image/'+(ext==='jpg'?'jpeg':ext), safeDriveName_(customerName)+'.'+ext);
    const folder = DriveApp.getFolderById('1AmtCgoW3OGVWcye50jrsv48uOpDhMVN4');
    const file = folder.createFile(blob).setName(safeDriveName_(customerName)+'.'+ext);
    const proofUrl = file.getUrl(), now = new Date();

    let ps = getSpreadsheet_().getSheets().find(sh => String(sh.getName()).trim().toUpperCase() === 'PAYMENTS') || null;
    if (!ps) ps = getSpreadsheet_().insertSheet('Payments');
    const paymentHeaders = ['Date','CustomerID','CustomerName','Meal','Amount','PaymentMode','PaymentStatus','PaymentProof','DeliveryBoyID','PaymentTime'];
    if (ps.getLastRow() === 0) ps.getRange(1,1,1,paymentHeaders.length).setValues([paymentHeaders]);
    let ph = ps.getRange(1,1,1,Math.max(ps.getLastColumn(),1)).getDisplayValues()[0].map(x=>clean_(x));
    if (ph.every(x=>!x)) { ph=paymentHeaders.slice(); ps.getRange(1,1,1,ph.length).setValues([ph]); }
    else paymentHeaders.forEach(name=>{ if(col_(ph,[name])<0){ ph.push(name); ps.getRange(1,ph.length).setValue(name); } });
    const pc = {
      date:col_(ph,['Date','Payment Date']), cid:col_(ph,['CustomerID','Customer ID','Cust ID']), name:col_(ph,['CustomerName','Customer Name','Name']),
      meal:col_(ph,['Meal','Meal Type','Shift']), amount:col_(ph,['Amount','Paid Amount','Payment Amount']), mode:col_(ph,['PaymentMode','Payment Mode','Mode']),
      status:col_(ph,['PaymentStatus','Payment Status','Status']), proof:col_(ph,['PaymentProof','Payment Proof','Proof','Receipt','Photo','Image']),
      boy:col_(ph,['DeliveryBoyID','Delivery Boy ID','Collected By','Boy ID']), time:col_(ph,['PaymentTime','Payment Time','Time'])
    };
    const pr = new Array(ph.length).fill('');
    const put=(i,v)=>{if(i>=0)pr[i]=v;};
    put(pc.date,Utilities.parseDate(date,APP_CFG.TIMEZONE,'yyyy-MM-dd')); put(pc.cid,cid); put(pc.name,customerName); put(pc.meal,meal);
    put(pc.amount,amount); put(pc.mode,mode); put(pc.status,'PAID'); put(pc.proof,proofUrl); put(pc.boy,profile.id);
    put(pc.time,Utilities.formatDate(now,APP_CFG.TIMEZONE,'dd/MM/yyyy HH:mm:ss'));
    ps.appendRow(pr);
    sheet.getRange(demoRow,dc.pay+1).setValue('PAID');
    SpreadsheetApp.flush();
    return {ok:true,message:'Payment collected and saved.',proofUrl:proofUrl,customerName:customerName};
  } catch(e) {
    return {ok:false,message:'Payment could not be saved: '+(e&&e.message?e.message:'Please try again.')};
  } finally { lock.releaseLock(); }
}
function safeDriveName_(name) {
  return String(name||'Demo Customer').replace(/[\\/:*?"<>|#%{}~&]/g,' ').replace(/\s+/g,' ').trim().slice(0,120) || 'Demo Customer';
}

function addDeliveryNote(token, deliveryId, note) {
  const profile = session_(token);
  if (!profile) return { ok:false, message:'Your session has expired.' };
  const sh = getSheet_(APP_CFG.SHEETS.deliveries);
  if (!sh) return { ok:false };
  const t = readTable_(sh);
  const D = deliveryColumns_(t.headers);
  const cNote = col_(t.headers, ['Notes','Note','Remark','Remarks']);
  if (D.id < 0 || cNote < 0) return { ok:false, message:'No Notes column in Deliveries sheet.' };
  const values = sh.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (clean_(values[i][D.id]) === clean_(deliveryId)) {
      const boyCol = D.boy;
      if (boyCol >= 0 && clean_(values[i][boyCol]).toUpperCase() !== profile.id) return { ok:false };
      sh.getRange(i + 1, cNote + 1).setValue(clean_(note).slice(0, 300));
      return { ok:true };
    }
  }
  return { ok:false };
}


/* ---------- Attendance location (Settings1: Latitude, Longitude, Attendance Radius in metres) ---------- */
function geoConfig_() {
  const out = { configured:false, lat:0, lng:0, radius:0 };
  try {
    const sh = settingsSheet_(); if (!sh) return out;
    let lat = null, lng = null, rad = null;
    const num = s => { const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; };
    settingsSources_(sh).forEach(s => {
      const tk = String(s.text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean), has = (...a) => a.some(x => tk.indexOf(x) >= 0);
      const raw = String(s.disp).trim(), pair = raw.match(/(-?\d{1,3}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)/);
      const isLat = has('latitude', 'lattitude', 'lat'), isLng = has('longitude', 'longtitude', 'lng', 'long', 'lon');
      if (pair && lat === null && (has('location', 'coordinates', 'geo', 'geolocation', 'latlong', 'latlng', 'position') || (isLat && isLng))) { lat = Number(pair[1]); lng = Number(pair[2]); return; }
      const plain = /^-?\d+(\.\d+)?$/.test(raw.replace(/\s/g, ''));
      if (isLat && !isLng && lat === null && plain && Math.abs(Number(raw)) <= 90) lat = Number(raw);
      if (isLng && !isLat && lng === null && plain && Math.abs(Number(raw)) <= 180) lng = Number(raw);
      if (has('radius') && rad === null) { const n = num(raw); if (n !== null && n > 0) rad = n; }
    });
    if (lat !== null && lng !== null && rad > 0) { out.configured = true; out.lat = lat; out.lng = lng; out.radius = rad; }
  } catch (e) {}
  return out;
}
function distanceM_(la1, lo1, la2, lo2) {
  const R = 6371000, rad = x => x * Math.PI / 180, dLa = rad(la2 - la1), dLo = rad(lo2 - lo1);
  const a = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ---------- Today's attendance for this boy (one punch per shift) ---------- */
function attendanceToday_(profile, now) {
  const out = { LUNCH:{ marked:false, time:'', status:'' }, DINNER:{ marked:false, time:'', status:'' }, sheet:false };
  const sh = findAttendanceSheet_(); if (!sh) return out;
  out.sheet = true;
  const tz = APP_CFG.TIMEZONE, today = Utilities.formatDate(now, tz, 'yyyy-MM-dd'), lc = sh.getLastColumn(), lr = sh.getLastRow();
  if (lr < 2) return out;
  const hdr = sh.getRange(1, 1, 1, lc).getValues()[0].map(normHeader_), ix = n => hdr.indexOf(n);
  const cDate = ix('date'), cEmp = ix('employee') >= 0 ? ix('employee') : ix('employeename');
  const rng = sh.getRange(2, 1, lr - 1, lc), vals = rng.getValues(), disp = rng.getDisplayValues();
  const me = [String(profile.id).toUpperCase(), String(profile.name).toUpperCase()];
  for (let i = vals.length - 1; i >= 0; i--) {
    const d = vals[i][cDate], e = clean_(vals[i][cEmp]).toUpperCase();
    const dk = (d instanceof Date && !isNaN(d)) ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : dateKeyFromCell_(d);
    if (dk !== today || me.indexOf(e) < 0) continue;
    [['LUNCH', 'lunch'], ['DINNER', 'dinner']].forEach(p => {
      const cs = ix(p[1] + 'status'), ct = ix(p[1] + 'checkin');
      const st = cs >= 0 ? clean_(disp[i][cs]) : '', tm = ct >= 0 ? clean_(disp[i][ct]) : '';
      out[p[0]] = { marked: tm !== '' || /present|late|half/i.test(st), time: tm, status: st };
    });
    break;
  }
  return out;
}
// Is attendance allowed for the CURRENT shift at all? (assigned shift + weekly off)
function shiftAllowance_(profile, now) {
  const tz = APP_CFG.TIMEZONE, meal = currentMeal_(), name = meal === 'LUNCH' ? 'lunch' : 'dinner';
  const sched = boyScheduleInfo_(profile), cfg = shiftConfig_();
  const offMap = hasKeys_(sched.weekOff) ? sched.weekOff : cfg.weekOff;
  const dow = Number(Utilities.formatDate(now, tz, 'u')) % 7;
  if (sched.shift !== 'BOTH' && sched.shift !== meal) return { allowed:false, code:'NOT_SHIFT', meal:meal, message:'Attendance is not required now. Your assigned shift is ' + sched.shift.toLowerCase() + ' only.' };
  if (offMap && offMap[dow] && offMap[dow][meal]) return { allowed:false, code:'WEEK_OFF', meal:meal, message:'Today is your weekly off for the ' + name + ' shift. Attendance is not required.' };
  return { allowed:true, meal:meal };
}
// Called when the app opens: tells the app whether attendance still has to be marked for the current shift.
function getAttendanceStatus(token) {
  const profile = session_(token);
  if (!profile) return { ok:false, message:'Your session has expired. Please log in again.' };
  const now = new Date(), allow = shiftAllowance_(profile, now), today = attendanceToday_(profile, now), geo = geoConfig_();
  const m = allow.meal, cfg = shiftConfig_();
  return { ok:true, meal:m, allowed:allow.allowed, reason:allow.message || '', marked:today[m].marked, time:today[m].time, status:today[m].status,
    sheet:today.sheet, geo:{ configured:geo.configured, lat:geo.lat, lng:geo.lng, radius:geo.radius },
    punchBy:fmt12_(cfg[m].punchBy), shiftStart:fmt12_(cfg[m].start) };
}

function checkIn(token, lat, lng, accuracy) {
  const profile = session_(token);
  if (!profile) return { ok:false, message:'Your session has expired. Please log in again.' };
  const la = Number(lat), lo = Number(lng);
  if (!isFinite(la) || !isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return { ok:false, message:'Invalid location.' };
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { return { ok:false, message:'Server is busy. Please try again.' }; }
  try {
    const now = new Date(), tz = Session.getScriptTimeZone(), meal = currentMeal_(), name = meal === 'LUNCH' ? 'lunch' : 'dinner';
    // 1. assigned shift + weekly off
    const allow = shiftAllowance_(profile, now);
    if (!allow.allowed) return { ok:false, code:allow.code, message:allow.message };
    // 2. only ONE attendance per shift
    const done = attendanceToday_(profile, now)[meal];
    if (done.marked) return { ok:false, code:'ALREADY', message:'Attendance for the ' + name + ' shift is already marked' + (done.time ? ' at ' + done.time : '') + '. Only one attendance per shift is allowed.', time:done.time };
    // 3. must be inside the attendance radius (Settings1)
    const geo = geoConfig_(); let dist = null;
    if (geo.configured) {
      dist = distanceM_(la, lo, geo.lat, geo.lng);
      if (dist > geo.radius) return { ok:false, code:'OUT_OF_RANGE', distance:Math.round(dist), radius:geo.radius,
        message:'You are ' + Math.round(dist) + ' m away from the attendance location. Check-in is allowed only within ' + geo.radius + ' m.' };
    }
    const ss = getSpreadsheet_();
    let sh = ss.getSheetByName(APP_CFG.SHEETS.checkins);
    if (!sh) {
      sh = ss.insertSheet(APP_CFG.SHEETS.checkins);
      sh.appendRow(['Timestamp','DeliveryBoyID','Name','Date','Latitude','Longitude','AccuracyMeters','MapLink']);
    }
    sh.appendRow([Utilities.formatDate(now, tz, 'dd MMM yyyy hh:mm a'), profile.id, profile.name, dateKey_(now), la, lo,
      isFinite(Number(accuracy)) ? Math.round(Number(accuracy)) : '', 'https://www.google.com/maps?q=' + la + ',' + lo]);
    let att = { saved:false };
    try { att = markAttendance_(profile, now); } catch (e) { att = { saved:false, error:String(e && e.message || e) }; }
    return { ok:true, time:Utilities.formatDate(now, APP_CFG.TIMEZONE, 'hh:mm a'), date:Utilities.formatDate(now, APP_CFG.TIMEZONE, 'dd MMM yyyy'),
      meal:meal, attendance:att, status:att.half ? 'HALF' : 'PRESENT', punchBy:fmt12_(shiftConfig_()[meal].punchBy),
      distance:dist === null ? null : Math.round(dist), radius:geo.configured ? geo.radius : null, lat:la, lng:lo };
  } finally { lock.releaseLock(); }
}

/* ---------- Empty boxes (BOX sheet) ---------- */
function getBoxDetails(token) {
  const profile = session_(token);
  if (!profile) return { ok:false, message:'Your session has expired. Please log in again.' };
  const r = getBoxData_(profile);
  r.ok = true;
  r.generatedAt = Utilities.formatDate(new Date(), APP_CFG.TIMEZONE, 'hh:mm:ss a');
  return r;
}
function boxColumns_(h) {
  return {
    id:    col_(h, ['BoxQR','Box QR','BoxID','Box ID','QRCode','QR Code','QR']),
    st:    col_(h, ['BoxStatus','Box Status','Status']),
    cust:  col_(h, ['CurrentCustomer','Current Customer','Customer','CustomerID','Customer ID','CustomerName','Customer Name']),
    disp:  col_(h, ['BoxDisplay','Box Display']),
    ldate: col_(h, ['LastDeliveryDate','Last Delivery Date']),
    lret:  col_(h, ['LastReturnDate','Last Return Date']),
    lmeal: col_(h, ['LastDeliveryMeal','Last Delivery Meal']),
    by:    col_(h, ['DeliveredBy','Delivered By']),
    rdate: col_(h, ['ReturnDate','Return Date','Returned At']),
    rby:   col_(h, ['ReturnedBy','Returned By','Return Delivery Boy']),
    rem:   col_(h, ['Remark','Remarks','Notes','Note'])
  };
}
// "DWB0079" / "dwb 79" / "https://…?box=DWB0079" -> comparable key "DWB79"
function boxKey_(text) {
  const s = String(text || '').toUpperCase();
  const m = s.match(/DWB\s*-?\s*(\d+)/);
  return m ? 'DWB' + Number(m[1]) : s.replace(/[^A-Z0-9]/g, '');
}
function boxStatus_(raw) { const s = String(raw || '').toUpperCase(); return /WITH/.test(s) ? 'WITH CUSTOMER' : /AVAIL/.test(s) ? 'AVAILABLE' : (s.trim() ? s.trim() : 'UNKNOWN'); }
function customerIndex_() {
  const ct = table_(APP_CFG.SHEETS.customers), C = customerColumns_(ct.headers), byKey = {};
  ct.rows.forEach(r => { const o = customerObject_(r, C); if (!o.customerId) return; byKey[o.customerId.toUpperCase()] = o; byKey[String(o.customerName).toUpperCase()] = o; });
  return byKey;
}
// customers that belong to this delivery boy (CUSTOMER master + ROUTE)
function mineSet_(profile) {
  const ct = table_(APP_CFG.SHEETS.customers), C = customerColumns_(ct.headers), info = {}, mine = {};
  ct.rows.forEach(r => {
    const id = val_(r, C.id).toUpperCase(); if (!id) return;
    const o = customerObject_(r, C); info[id] = o; info[String(o.customerName).toUpperCase()] = o;
    if (o.deliveryBoyId.toUpperCase() === profile.id || ['LUNCH','DINNER'].some(m => effectiveBoy_(forMeal_(o, m)).id === profile.id)) { mine[id] = true; mine[String(o.customerName).toUpperCase()] = true; }
  });
  const rt = table_(APP_CFG.SHEETS.route), R = routeColumns_(rt.headers);
  rt.rows.forEach(r => { if (val_(r, R.boy).toUpperCase() === profile.id) { mine[val_(r, R.cid).toUpperCase()] = true; mine[val_(r, R.name).toUpperCase()] = true; } });
  return { info:info, mine:mine };
}
function lookupBox(token, text) {
  const profile = session_(token);
  if (!profile) return { ok:false, message:'Your session has expired. Please log in again.' };
  const r = lookupBox_(profile, text); r.ok = true; return r;
}
function lookupBox_(profile, text) {
  const key = boxKey_(text), out = { found:false, boxId:(String(text || '').toUpperCase().match(/DWB\s*-?\s*\d+/) || [String(text || '').trim()])[0].replace(/\s|-/g, ''),
    status:'UNKNOWN', customerId:'', customerName:'', mobile:'', address:'', remark:'', mealTypeLabel:'REGULAR', lastDate:'', lastMeal:'' };
  if (!key) return out;
  const sh = getSheet_(APP_CFG.SHEETS.box); if (!sh) return out;
  const t = readTable_(sh), B = boxColumns_(t.headers); if (B.id < 0) return out;
  const idx = customerIndex_();
  for (let i = 0; i < t.rows.length; i++) {
    const r = t.rows[i]; if (boxKey_(val_(r, B.id)) !== key) continue;
    out.found = true; out.boxId = val_(r, B.id);
    out.status = B.st >= 0 ? boxStatus_(val_(r, B.st)) : 'UNKNOWN';
    const cv = B.cust >= 0 ? val_(r, B.cust) : '';
    if (cv) { const c = idx[cv.toUpperCase()] || {}; out.customerId = c.customerId || cv; out.customerName = c.customerName || cv; out.mobile = c.mobile || ''; out.address = c.address || c.area || ''; out.mealTypeLabel = c.customerId ? orderLabel_(c) : 'REGULAR'; }
    if (out.status === 'AVAILABLE') { out.customerId = ''; out.customerName = ''; out.mobile = ''; out.address = ''; }
    out.lastDate = B.ldate >= 0 ? dateKeyFromCell_(t.rows[i][B.ldate]) : '';
    out.lastMeal = B.lmeal >= 0 ? val_(r, B.lmeal) : '';
    out.remark = B.rem >= 0 ? val_(r, B.rem) : '';
    break;
  }
  return out;
}
// value for a date cell, typed like the other cells already in that column (real date or dd/MM/yyyy text)
function dateLikeColumn_(sh, col1, dateKey) {
  const tz = Session.getScriptTimeZone(), lr = sh.getLastRow();
  if (lr >= 2) {
    const vals = sh.getRange(2, col1, lr - 1, 1).getValues();
    for (let i = 0; i < vals.length; i++) { if (vals[i][0] instanceof Date) return Utilities.parseDate(dateKey, tz, 'yyyy-MM-dd'); if (clean_(vals[i][0])) return Utilities.formatDate(Utilities.parseDate(dateKey, tz, 'yyyy-MM-dd'), tz, 'dd/MM/yyyy'); }
  }
  return Utilities.parseDate(dateKey, tz, 'yyyy-MM-dd');
}
function setIfPlain_(sh, row, col0, value) {          // col0 is 0-based; never overwrites a formula
  if (col0 < 0) return;
  const c = sh.getRange(row, col0 + 1);
  if (!c.getFormula()) c.setValue(value);
}
// After a box is handed over: BOX sheet -> WITH CUSTOMER + current customer + last delivery info.
function assignBoxToCustomer_(boxId, item, profile, dateKey, meal) {
  const sh = getSheet_(APP_CFG.SHEETS.box); if (!sh) return false;
  const lc = sh.getLastColumn(), lr = sh.getLastRow(); if (lr < 2) return false;
  const h = sh.getRange(1, 1, 1, lc).getValues()[0], B = boxColumns_(h.map(clean_));
  if (B.id < 0 || B.st < 0) return false;
  const vals = sh.getRange(2, 1, lr - 1, lc).getValues(), key = boxKey_(boxId), idx = customerIndex_();
  let useName = false;                                  // copy the style of an existing "with customer" row (ID or name)
  for (let i = 0; i < vals.length && B.cust >= 0; i++) {
    if (boxStatus_(vals[i][B.st]) === 'WITH CUSTOMER' && clean_(vals[i][B.cust])) { const v = clean_(vals[i][B.cust]).toUpperCase(); useName = !!idx[v] && idx[v].customerId.toUpperCase() !== v; break; }
  }
  const custVal = useName ? item.customerName : item.customerId;
  for (let i = 0; i < vals.length; i++) {
    if (boxKey_(vals[i][B.id]) !== key) continue;
    const row = i + 2;
    if (sh.getRange(row, B.st + 1).getFormula()) return false;      // status is calculated – leave it alone
    // ordinal of this box among the customer's boxes ("2. DWB0032")
    let n = 1;
    vals.forEach((v, k) => { if (k !== i && B.cust >= 0 && boxStatus_(v[B.st]) === 'WITH CUSTOMER' && clean_(v[B.cust]).toUpperCase() === String(custVal).toUpperCase()) n++; });
    setIfPlain_(sh, row, B.st, 'WITH CUSTOMER');
    setIfPlain_(sh, row, B.cust, custVal);
    if (B.ldate >= 0) setIfPlain_(sh, row, B.ldate, dateLikeColumn_(sh, B.ldate + 1, dateKey));
    if (B.lmeal >= 0) setIfPlain_(sh, row, B.lmeal, meal === 'DINNER' ? 'Dinner' : 'Lunch');
    if (B.by >= 0) setIfPlain_(sh, row, B.by, profile.id);
    if (B.disp >= 0) setIfPlain_(sh, row, B.disp, n + '. ' + clean_(vals[i][B.id]));
    SpreadsheetApp.flush();
    return true;
  }
  return false;
}
// BOX sheet: ids of the boxes currently WITH CUSTOMER for one customer
function customerBoxIds_(customerId) {
  const out = [], sh = getSheet_(APP_CFG.SHEETS.box); if (!sh) return out;
  const t = readTable_(sh), B = boxColumns_(t.headers); if (B.id < 0 || B.st < 0 || B.cust < 0) return out;
  const idx = customerIndex_(), want = String(customerId || '').toUpperCase();
  t.rows.forEach(r => {
    if (boxStatus_(val_(r, B.st)) !== 'WITH CUSTOMER') return;
    const cv = val_(r, B.cust).toUpperCase(), c = idx[cv];
    if (((c && c.customerId) || cv).toUpperCase() === want) out.push(val_(r, B.id));
  });
  return out;
}
// Delivery boy collects an empty box: BOX sheet -> AVAILABLE, customer cleared, return date set.
function returnBox(token, boxId, expectedCustomerId, note) {
  const profile = session_(token);
  if (!profile) return { ok:false, message:'Your session has expired. Please log in again.' };
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) { return { ok:false, message:'Server is busy. Please try again.' }; }
  try {
    const sh = getSheet_(APP_CFG.SHEETS.box); if (!sh) return { ok:false, message:'BOX sheet not found.' };
    const lc = sh.getLastColumn(), lr = sh.getLastRow(); if (lr < 2) return { ok:false, message:'BOX sheet is empty.' };
    const h = sh.getRange(1, 1, 1, lc).getValues()[0], B = boxColumns_(h.map(clean_));
    if (B.id < 0 || B.st < 0) return { ok:false, message:'BOX sheet needs Box QR and Status columns.' };
    const vals = sh.getRange(2, 1, lr - 1, lc).getValues(), key = boxKey_(boxId);
    for (let i = 0; i < vals.length; i++) {
      if (boxKey_(vals[i][B.id]) !== key) continue;
      const row = i + 2, v = vals[i];
      if (boxStatus_(v[B.st]) !== 'WITH CUSTOMER') return { ok:false, message:'Box ' + clean_(v[B.id]) + ' is already AVAILABLE.' };
      const ms = mineSet_(profile), holder = B.cust >= 0 ? clean_(v[B.cust]).toUpperCase() : '';
      const byMe = B.by >= 0 && [profile.id, String(profile.name).toUpperCase()].indexOf(clean_(v[B.by]).toUpperCase()) >= 0;
      const holderId = String((ms.info[holder] || {}).customerId || holder).toUpperCase();
      if (expectedCustomerId && holderId !== String(expectedCustomerId).toUpperCase())
        return { ok:false, message:'This box belongs to ' + ((ms.info[holder] || {}).customerName || holder) + ', not the selected customer.' };
      if (holder && !ms.mine[holder] && !byMe) return { ok:false, message:'This box belongs to another delivery boy\'s customer.' };
      if (sh.getRange(row, B.st + 1).getFormula()) return { ok:false, message:'Box status is calculated in the sheet and cannot be changed here.' };
      const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      const c = ms.info[holder] || {};
      setIfPlain_(sh, row, B.st, 'AVAILABLE');
      setIfPlain_(sh, row, B.cust, '');
      setIfPlain_(sh, row, B.disp, '');
      if (B.rem >= 0 && clean_(note)) setIfPlain_(sh, row, B.rem, 'RETURNED - ' + clean_(note).slice(0, 250));
      if (B.rby >= 0) setIfPlain_(sh, row, B.rby, profile.id);
      if (B.lret >= 0) setIfPlain_(sh, row, B.lret, dateLikeColumn_(sh, B.lret + 1, today));
      if (B.rdate >= 0) setIfPlain_(sh, row, B.rdate, dateLikeColumn_(sh, B.rdate + 1, today));
      SpreadsheetApp.flush();
      let left = []; try { left = customerBoxIds_(holderId); } catch (e) {}
      return { ok:true, boxId:clean_(v[B.id]), customerId:holderId, customerName:c.customerName || holder, remaining:left.length, remainingIds:left, status:'AVAILABLE', time:Utilities.formatDate(new Date(), APP_CFG.TIMEZONE, 'hh:mm a') };
    }
    return { ok:false, message:'Box not found in the BOX sheet.' };
  } finally { lock.releaseLock(); }
}

function getBoxData_(profile) {
  const sh = getSheet_(APP_CFG.SHEETS.box);
  if (!sh) return { found:false, recognized:false, items:[], total:0, customers:0, headers:[] };
  const t = readTable_(sh), h = t.headers, B = boxColumns_(h);

  const ms = mineSet_(profile), info = ms.info, mine = ms.mine;

  // ---- one row per box:  Box QR | Status | Current Customer | ... ----
  if (B.id >= 0 && B.st >= 0) {
    const agg = {};
    t.rows.forEach(r => {
      if (boxStatus_(val_(r, B.st)) !== 'WITH CUSTOMER') return;
      const cv = B.cust >= 0 ? val_(r, B.cust) : ''; if (!cv) return;
      const c = info[cv.toUpperCase()]; const key = (c && c.customerId || cv).toUpperCase();
      const byMe = B.by >= 0 && [profile.id, String(profile.name).toUpperCase()].indexOf(val_(r, B.by).toUpperCase()) >= 0;
      if (!mine[key] && !mine[cv.toUpperCase()] && !byMe) return;
      if (!agg[key]) agg[key] = { customerId:(c && c.customerId) || cv, customerName:(c && c.customerName) || cv, mobile:(c && c.mobile) || '',
        address:(c && (c.address || c.area)) || '', mealType:(c && (c.orderType || c.mealType)) || '', mealTypeLabel:c ? orderLabel_(c) : 'REGULAR', boxes:0, boxIds:[], boxList:[] };
      agg[key].boxes++; agg[key].boxIds.push(val_(r, B.id));
      agg[key].boxList.push({ id:val_(r, B.id), date:B.ldate >= 0 ? dateKeyFromCell_(r[B.ldate]) : '', meal:B.lmeal >= 0 ? val_(r, B.lmeal) : '' });
    });
    const items = Object.keys(agg).map(k => agg[k]).sort((a, b) => b.boxes - a.boxes || String(a.customerName).localeCompare(String(b.customerName)));
    return { found:true, recognized:true, mode:'perBox', items:items, total:items.reduce((s, x) => s + x.boxes, 0), customers:items.length, headers:h };
  }

  // ---- count ledger fallback ----
  const X = {
    cid:  col_(h, ['CustomerID','Customer ID','Cust ID']),
    name: col_(h, ['CustomerName','Customer Name','Customer','Name']),
    boy:  col_(h, ['DeliveryBoyID','Delivery Boy ID','Boy ID','Delivery Boy']),
    bal:  col_(h, ['BoxesWithCustomer','Boxes With Customer','Box With Customer','BoxWithCustomer','PendingBoxes','Pending Boxes','Pending Box','Box Balance','BoxBalance','Balance','EmptyBoxes','Empty Boxes','Empty Box','BoxesPending','Boxes']),
    iss:  col_(h, ['BoxIssued','Boxes Issued','Issued','BoxGiven','Boxes Given','Given','BoxDelivered','Boxes Delivered']),
    ret:  col_(h, ['BoxReturned','Boxes Returned','Returned','BoxCollected','Boxes Collected','Collected','Received']),
    qty:  col_(h, ['BoxQty','Box Qty','Qty','Quantity','Count']),
    st:   col_(h, ['Status'])
  };
  const recognized = X.bal >= 0 || X.iss >= 0 || X.qty >= 0;
  if (!recognized || (X.cid < 0 && X.name < 0)) return { found:true, recognized:false, items:[], total:0, customers:0, headers:h };
  const agg = {};
  t.rows.forEach(r => {
    const rid = val_(r, X.cid).toUpperCase(), rname = val_(r, X.name).toUpperCase();
    const key = rid || rname; if (!key) return;
    if (X.boy >= 0 && val_(r, X.boy)) { if (val_(r, X.boy).toUpperCase() !== profile.id) return; }
    else if (!mine[rid] && !mine[rname]) return;
    let n;
    if (X.bal >= 0) n = num_(val_(r, X.bal));
    else if (X.iss >= 0) n = num_(val_(r, X.iss)) - (X.ret >= 0 ? num_(val_(r, X.ret)) : 0);
    else { n = num_(val_(r, X.qty)); if (X.st >= 0 && /return|collect|receiv|closed|done/i.test(val_(r, X.st))) n = 0; }
    if (!(n > 0)) return;
    const c = info[rid] || info[rname] || {};
    if (!agg[key]) agg[key] = { customerId:rid || c.customerId || '', customerName:val_(r, X.name) || c.customerName || rid, mobile:c.mobile || '', address:c.address || c.area || '', mealType:c.orderType || c.mealType || '', mealTypeLabel:c.customerId ? orderLabel_(c) : 'REGULAR', boxes:0, boxIds:[] };
    agg[key].boxes += n;
  });
  const items = Object.keys(agg).map(k => agg[k]).sort((a, b) => b.boxes - a.boxes || String(a.customerName).localeCompare(String(b.customerName)));
  return { found:true, recognized:true, mode:'count', items:items, total:items.reduce((s, x) => s + x.boxes, 0), customers:items.length, headers:h };
}

/* ---------- Live location ---------- */
function currentMeal_() {
  const hm = Utilities.formatDate(new Date(), APP_CFG.TIMEZONE, 'HH:mm').split(':');
  const lunchEnd = (shiftConfig_().LUNCH || {}).end;      // lunch shift end from Settings1 (16:30 by default)
  return (Number(hm[0]) * 60 + Number(hm[1])) >= (lunchEnd > 0 ? lunchEnd : APP_CFG.DINNER_FROM_MINUTES) ? 'DINNER' : 'LUNCH';
}
// Called by the app every ~30s while it is open and location is allowed.
function updateLiveLocation(token, lat, lng, accuracy) {
  const profile = session_(token);
  if (!profile) return { ok:false, message:'Your session has expired. Please log in again.' };
  if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') {      // phone location is off / unavailable
    try { upsertLive_(profile, null, null, null, 'Offline'); } catch (e) { return { ok:false, message:'Could not write to the LIVE_LOCATIONS sheet: ' + (e && e.message || e) }; }
    return { ok:true, offline:true, time:Utilities.formatDate(new Date(), APP_CFG.TIMEZONE, 'hh:mm:ss a') };
  }
  const la = Number(lat), lo = Number(lng);
  if (!isFinite(la) || !isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180 || (la === 0 && lo === 0)) return { ok:false, message:'Invalid location.' };
  try { upsertLive_(profile, la, lo, accuracy, 'On Duty'); }
  catch (e) { return { ok:false, message:'Could not write to the LIVE_LOCATIONS sheet: ' + (e && e.message || e) }; }
  return { ok:true, time:Utilities.formatDate(new Date(), APP_CFG.TIMEZONE, 'hh:mm:ss a') };
}

// Finds (or appends) a header column by any of its aliases. Returns the 1-based column number.
function ensureCol_(sh, aliases) {
  const lc = Math.max(1, sh.getLastColumn());
  const h = sh.getRange(1, 1, 1, lc).getValues()[0].map(normHeader_);
  for (let i = 0; i < aliases.length; i++) { const k = h.indexOf(normHeader_(aliases[i])); if (k >= 0) return k + 1; }
  const c = h.filter(x => x !== '').length ? lc + 1 : 1;
  sh.getRange(1, c).setValue(aliases[0]);
  return c;
}
function upsertLive_(profile, la, lo, accuracy, status) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = getSpreadsheet_(), tz = APP_CFG.TIMEZONE, now = new Date();
    let sh = ss.getSheetByName(APP_CFG.SHEETS.live);
    if (!sh) { sh = ss.insertSheet(APP_CFG.SHEETS.live); sh.appendRow(['DeliveryBoyID','DeliveryBoyNAME','MAIL','Location','LastUpdated']); sh.setFrozenRows(1); }
    const C = {
      id:   ensureCol_(sh, ['DeliveryBoyID','Delivery Boy ID','Boy ID']),
      name: ensureCol_(sh, ['DeliveryBoyNAME','DeliveryBoyName','Delivery Boy Name','Name']),
      loc:  ensureCol_(sh, ['Location']),
      upd:  ensureCol_(sh, ['LastUpdated','Last Updated']),
      lat:  ensureCol_(sh, ['Latitude']),
      lng:  ensureCol_(sh, ['Longitude']),
      acc:  ensureCol_(sh, ['AccuracyMeters']),
      map:  ensureCol_(sh, ['MapLink']),
      st:   ensureCol_(sh, ['Status']),
      meal: ensureCol_(sh, ['Meal'])
    };
    const hasPos = la !== null && lo !== null && isFinite(la) && isFinite(lo);
    const acc = (accuracy !== null && accuracy !== '' && isFinite(Number(accuracy))) ? Math.round(Number(accuracy)) : '';
    const stamp = Utilities.formatDate(now, tz, 'dd MMM yyyy hh:mm:ss a');
    const mapUrl = hasPos ? 'https://www.google.com/maps?q=' + la + ',' + lo : '';
    const last = sh.getLastRow();
    const idVals = last > 1 ? sh.getRange(2, C.id, last - 1, 1).getValues().map(r => clean_(r[0]).toUpperCase()) : [];
    let row = idVals.indexOf(String(profile.id).toUpperCase()) + 2;
    if (row < 2) { row = Math.max(last, 1) + 1; sh.getRange(row, C.id).setValue(profile.id); sh.getRange(row, C.name).setValue(profile.name); }
    const set = (c, v) => sh.getRange(row, c).setValue(v);
    if (hasPos) {
      sh.getRange(row, C.loc).setFormula('=HYPERLINK("' + mapUrl + '","' + Number(la).toFixed(6) + ', ' + Number(lo).toFixed(6) + '")');
      set(C.lat, la); set(C.lng, lo); set(C.acc, acc); set(C.map, mapUrl);
    }
    set(C.upd, stamp); set(C.st, status); set(C.meal, currentMeal_());
    SpreadsheetApp.flush();

    // breadcrumb history, at most one row every 2 minutes per boy
    if (hasPos) {
      const cache = CacheService.getScriptCache(), ck = 'db_hist_' + profile.id;
      if (!cache.get(ck)) {
        cache.put(ck, '1', 120);
        let hs = ss.getSheetByName(APP_CFG.SHEETS.history);
        if (!hs) { hs = ss.insertSheet(APP_CFG.SHEETS.history); hs.appendRow(['Timestamp','DeliveryBoyID','Name','Latitude','Longitude','AccuracyMeters','MapLink']); hs.setFrozenRows(1); }
        hs.appendRow([stamp, profile.id, profile.name, la, lo, acc, mapUrl]);
      }
    }
  } finally { lock.releaseLock(); }
}

/* ---------- Attendance (the sheet with Date | Employee | LunchStatus | DinnerStatus | LunchCheckIn | DinnerCheckIn | ...) ---------- */
function findAttendanceSheet_() {
  const ss = getSpreadsheet_();
  if (APP_CFG.SHEETS.attendance) { const n = ss.getSheetByName(APP_CFG.SHEETS.attendance); if (n) return n; }
  const all = ss.getSheets();
  for (let i = 0; i < all.length; i++) {
    const s = all[i]; if (s.getLastColumn() < 4 || s.getLastRow() < 1) continue;
    const h = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(normHeader_);
    if (h.indexOf('lunchcheckin') >= 0 && h.indexOf('dinnercheckin') >= 0) return s;   // found by its headers, whatever its tab name
  }
  return null;
}
// Writes today's check-in for the current meal. Returns {saved, sheet, meal, time}.
function markAttendance_(profile, now) {
  const sh = findAttendanceSheet_();
  if (!sh) return { saved:false };
  const tz = APP_CFG.TIMEZONE, meal = currentMeal_(), isL = meal === 'LUNCH';
  const timeTxt = Utilities.formatDate(now, tz, 'hh:mm a');
  const lc = sh.getLastColumn();
  const hdr = sh.getRange(1, 1, 1, lc).getValues()[0].map(normHeader_);
  const ix = n => hdr.indexOf(n);
  const cDate = ix('date'), cEmp = ix('employee') >= 0 ? ix('employee') : ix('employeename');
  const cSt = ix(isL ? 'lunchstatus' : 'dinnerstatus'), cIn = ix(isL ? 'lunchcheckin' : 'dinnercheckin'), cBy = ix(isL ? 'lunchmarkedby' : 'dinnermarkedby');
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const last = sh.getLastRow();
  const data = last > 1 ? sh.getRange(2, 1, last - 1, lc).getValues() : [];
  const me = [String(profile.id).toUpperCase(), String(profile.name).toUpperCase()];
  let row = -1;
  for (let i = data.length - 1; i >= 0; i--) {
    const d = data[i][cDate], e = clean_(data[i][cEmp]).toUpperCase();
    const dk = (d instanceof Date && !isNaN(d)) ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : dateKeyFromCell_(d);
    if (dk === today && me.indexOf(e) >= 0) { row = i + 2; break; }
  }
  if (row < 0) {
    row = last + 1;
    if (last >= 2) sh.getRange(last, 1, 1, lc).copyTo(sh.getRange(row, 1, 1, lc), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    if (cDate >= 0) sh.getRange(row, cDate + 1).setValue(Utilities.parseDate(today, tz, 'yyyy-MM-dd'));
    if (cEmp >= 0) sh.getRange(row, cEmp + 1).setValue(profile.name || profile.id);
  }
  const mins = Number(Utilities.formatDate(now, tz, 'HH')) * 60 + Number(Utilities.formatDate(now, tz, 'mm'));
  const late = mins > shiftConfig_()[meal].punchBy;      // punched after the Settings1 deadline (lunch 09:30 / dinner 17:30) = HALF DAY
  const firstIn = cIn < 0 || !clean_(sh.getRange(row, cIn + 1).getValue());      // only the first check-in of the meal counts
  if (cSt >= 0 && (firstIn || !clean_(sh.getRange(row, cSt + 1).getValue()))) sh.getRange(row, cSt + 1).setValue(late ? 'Half Day' : 'Present');
  if (cIn >= 0 && firstIn) sh.getRange(row, cIn + 1).setValue(timeTxt);
  if (cBy >= 0 && !clean_(sh.getRange(row, cBy + 1).getValue())) sh.getRange(row, cBy + 1).setValue((profile.name || profile.id) + ' (App)');
  SpreadsheetApp.flush();
  const cacheMonth = Utilities.formatDate(now, tz, 'yyyy-MM');
  CacheService.getScriptCache().remove('att_v2_' + String(profile.id || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '_') + '_' + cacheMonth);
  return { saved:true, sheet:sh.getName(), meal:meal, time:timeTxt, late:late, half:late };
}

/* =====================================================================
   SETTINGS1 — shift timings, punch-in deadlines, week off, payment QR
   The sheet "Settings1" is read flexibly. Any of these layouts work:
     A) Setting | Value rows      e.g.  "Lunch Shift Start" | 12:00 PM
     B) Header row + one value row  e.g.  LunchStart | LunchEnd | DinnerStart ...
     C) Matrix                       e.g.  (blank) | Lunch | Dinner   then   Shift Start | 12:00 PM | 7:00 PM
   Recognised settings (name can be written in many ways — spaces/case ignored):
     Lunch / Dinner  Shift Start, Shift End, Reporting Time, Punch In Before (deadline)
     Week Off  (e.g. "Sunday" or "Saturday, Sunday")
     QR Code Image  (image URL, Google Drive link, =IMAGE() formula or an image inside the cell)
     UPI ID (optional)
   Missing values fall back to SHIFT_DEFAULTS_.
   ===================================================================== */
const SHIFT_DEFAULTS_ = {
  LUNCH:  { start: 12*60,  end: 16*60+30, report: 11*60+45, punchBy: 9*60+30 },    // punch in before 09:30
  DINNER: { start: 19*60,  end: 22*60+30, report: 18*60+45, punchBy: 17*60+30 }    // punch in before 17:30
};
function settingsSheet_() {
  const want = normHeader_(APP_CFG.SHEETS.settings || 'Settings1');
  const all = getSpreadsheet_().getSheets();
  for (let i = 0; i < all.length; i++) if (normHeader_(all[i].getName()) === want) return all[i];
  return null;
}
// "12:00 PM", "9:30", "09.30 am", "6 PM"  ->  minutes since midnight, or -1
function parseClock_(v) {
  const t = String(v === null || v === undefined ? '' : v).trim();
  let m = t.match(/(\d{1,2})\s*[:.]\s*(\d{2})\s*([AaPp])?\.?\s*[Mm]?/);
  let h, mi, ap;
  if (m) { h = Number(m[1]); mi = Number(m[2]); ap = (m[3] || '').toUpperCase(); }
  else { m = t.match(/^(\d{1,2})\s*([AaPp])\.?[Mm]\.?$/); if (!m) return -1; h = Number(m[1]); mi = 0; ap = m[2].toUpperCase(); }
  if (ap === 'P' && h < 12) h += 12; if (ap === 'A' && h === 12) h = 0;
  return (h > 23 || mi > 59) ? -1 : h * 60 + mi;
}
function parseRange_(v) {
  const parts = String(v || '').split(/\s*(?:-|–|—|to)\s*/i);
  if (parts.length < 2) return null;
  let a = parseClock_(parts[0]), b = parseClock_(parts[1]);
  if (a < 0 || b < 0) return null;
  if (!/[AaPp][Mm]/.test(parts[0]) && /[Pp][Mm]/.test(parts[1]) && a < 12*60 && a + 12*60 < b) a += 12*60;   // "12:00 - 4:30 PM"
  return [a, b];
}
function fmt12_(min) {
  min = Math.max(0, Math.round(min)); const h = Math.floor(min / 60) % 24, m = min % 60;
  return ((h % 12) || 12) + ':' + ('0' + m).slice(-2) + ' ' + (h < 12 ? 'AM' : 'PM');
}
// "Sunday"  |  "Saturday, Sunday"  |  "Sunday - Lunch, Saturday - Dinner"  ->  { dow: { LUNCH:true, DINNER:true } }
// A token without a shift uses `hint` (e.g. from a "Week Off Shift" cell) and otherwise means BOTH shifts.
function mealsOf_(text) {
  const t = String(text === null || text === undefined ? '' : text).toLowerCase(), L = /lunch/.test(t), D = /dinner/.test(t);
  return (L && !D) ? ['LUNCH'] : (D && !L) ? ['DINNER'] : ['LUNCH', 'DINNER'];
}
function parseWeekOff_(v, hint) {
  const out = {}, map = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 }, base = (hint && hint.length) ? hint : ['LUNCH', 'DINNER'];
  String(v === null || v === undefined ? '' : v).split(/[,;\n|]+/).forEach(tok => {
    const t = tok.toLowerCase(); if (!t.trim()) return;
    const days = []; Object.keys(map).forEach(k => { if (new RegExp('(^|[^a-z])' + k).test(t)) days.push(map[k]); });
    if (!days.length) return;
    const meals = /lunch|dinner/.test(t) ? mealsOf_(t) : base;
    days.forEach(d => { out[d] = out[d] || {}; meals.forEach(m => { out[d][m] = true; }); });
  });
  return out;
}
function mergeWeekOff_(a, b) { Object.keys(b || {}).forEach(d => { a[d] = a[d] || {}; Object.keys(b[d]).forEach(m => { a[d][m] = true; }); }); return a; }
function hasKeys_(o) { return !!o && Object.keys(o).length > 0; }
function weekOffList_(map) {
  const N = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return Object.keys(map || {}).map(Number).sort().map(d => ({ day:N[d], dow:d, meals:Object.keys(map[d]).sort() }));
}
// Flattens Settings1 into {text, disp, val, r, c} entries: every text label paired with the value to its RIGHT and the value BELOW it,
// plus a Lunch | Dinner matrix. This covers "Label | Value" rows, "header row + value row" and "label above value" layouts.
function settingsSources_(sh) {
  const rg = sh.getDataRange(), vals = rg.getValues(), disp = rg.getDisplayValues(), out = [];
  const R = vals.length, C = R ? vals[0].length : 0, E = x => x === '' || x === null || x === undefined;
  const isLabel = s => { s = String(s === null || s === undefined ? '' : s).trim(); return s !== '' && !/^[-\d.,:\s]+([AaPp][Mm])?$/.test(s); };
  let mHead = -1, mL = -1, mD = -1;
  for (let r = 0; r < Math.min(R, 10) && mHead < 0; r++) {
    let l = -1, d = -1;
    for (let c = 0; c < C; c++) { const n = normHeader_(disp[r][c]); if (n === 'lunch' || n === 'lunchshift') l = c; if (n === 'dinner' || n === 'dinnershift') d = c; }
    if (l >= 0 && d >= 0) { mHead = r; mL = l; mD = d; }
  }
  if (mHead >= 0) {                                                  // matrix: Shift Start | 12:00 PM | 7:00 PM
    for (let r = mHead + 1; r < R; r++) {
      let c0 = -1; for (let c = 0; c < Math.min(mL, mD); c++) if (!E(disp[r][c])) { c0 = c; break; }
      if (c0 < 0) continue;
      out.push({ text: disp[r][c0] + ' lunch',  disp: disp[r][mL], val: vals[r][mL], r: r + 1, c: mL + 1 });
      out.push({ text: disp[r][c0] + ' dinner', disp: disp[r][mD], val: vals[r][mD], r: r + 1, c: mD + 1 });
    }
  }
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    if (!isLabel(disp[r][c])) continue;
    if (mHead >= 0 && r > mHead && /weekoff|weeklyoff|offday|dayoff/.test(normHeader_(disp[r][c]))) continue;   // handled by the Lunch | Dinner matrix
    for (let c2 = c + 1; c2 < C; c2++) if (!E(disp[r][c2]) || !E(vals[r][c2])) { out.push({ text: disp[r][c], disp: disp[r][c2], val: vals[r][c2], r: r + 1, c: c2 + 1, lr: r + 1, lc: c + 1 }); break; }
    if (r + 1 < R && (!E(disp[r + 1][c]) || !E(vals[r + 1][c]))) out.push({ text: disp[r][c], disp: disp[r + 1][c], val: vals[r + 1][c], r: r + 2, c: c + 1, lr: r + 1, lc: c + 1 });
  }
  return out;
}
function metricOf_(n) {
  if (/report/.test(n)) return 'report';
  if (/punch|checkin|deadline|cutoff|before|latetime|lateafter|grace/.test(n)) return 'punch';
  if (/end|till|close|finish|checkout|^to/.test(n)) return 'end';
  if (/start|from|begin|open/.test(n)) return 'start';
  if (/shift|timing|time|hours/.test(n)) return 'range';
  return '';
}
// Shift timings + week off from Settings1 (cached 2 min).
function shiftConfig_() {
  const cache = CacheService.getScriptCache(), hit = cache.get('db_shiftcfg_v3');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const cfg = { LUNCH: Object.assign({}, SHIFT_DEFAULTS_.LUNCH), DINNER: Object.assign({}, SHIFT_DEFAULTS_.DINNER), weekOff: {}, found: false };
  try {
    const sh = settingsSheet_();
    if (sh) {
      cfg.found = true;
      const src = settingsSources_(sh);
      ['LUNCH', 'DINNER'].forEach(meal => {
        const got = {};
        src.forEach(s => {
          const n = normHeader_(s.text); if (n.indexOf(meal.toLowerCase()) < 0) return;
          const m = metricOf_(n.replace(/lunch|dinner/g, '')); if (!m) return;
          if (m === 'range') { const rg = parseRange_(s.disp); if (rg && got.start === undefined) { got.start = rg[0]; got.end = rg[1]; } return; }
          const key = (m === 'punch') ? 'punchBy' : m, t = parseClock_(s.disp); if (t >= 0 && got[key] === undefined) got[key] = t;
        });
        Object.keys(got).forEach(k => { cfg[meal][k] = got[k]; });
        if (got.start !== undefined && got.report === undefined) cfg[meal].report = Math.max(0, got.start - 15);
      });
      // Week off: day(s) in "Week Off" / "Week Off Day" and, optionally, the shift in "Week Off Shift" (or Lunch / Dinner columns or inside the text)
      const woDone = {}, woDays = [], woShift = [];
      src.forEach(s => {
        const lab = normHeader_(s.text); if (!/weekoff|weeklyoff|offday|dayoff/.test(lab)) return;
        const key = s.lr !== undefined ? s.lr + ':' + s.lc : 'm' + s.r + ':' + s.c; if (woDone[key]) return;
        if (/shift|meal/.test(lab.replace(/lunch|dinner/g, ''))) { if (/lunch|dinner|both|all/i.test(s.disp)) { woDone[key] = 1; woShift.push(/both|all/i.test(s.disp) ? ['LUNCH','DINNER'] : mealsOf_(s.disp)); } return; }
        if (hasKeys_(parseWeekOff_(s.disp))) { woDone[key] = 1; woDays.push({ disp:s.disp, hint:/lunch|dinner/.test(lab) ? mealsOf_(lab) : null }); }
      });
      const shiftHint = woShift.length ? woShift[0] : null;
      woDays.forEach(d => { mergeWeekOff_(cfg.weekOff, parseWeekOff_(d.disp, d.hint || shiftHint)); });
    }
  } catch (e) {}
  try { cache.put('db_shiftcfg_v2', JSON.stringify(cfg), 120); } catch (e) {}
  return cfg;
}
// This delivery boy's own week off / shift / "show all customers" tick (DeliveryBoys sheet). Falls back to Settings1 / both shifts.
// DeliveryBoys sheet: "Show Backup" tick (+ optional "Backup Delivery Boy" column) for EVERY boy -> { DWE003:{on:true, backup:'DWE002'} }
function backupMap_() {
  if (backupMap_.c) return backupMap_.c;
  const out = {};
  try {
    const t = table_(APP_CFG.SHEETS.boys);
    const cId = col_(t.headers, ['DeliveryBoyID','Delivery Boy ID','Boy ID','Agent ID','Employee ID']);
    const cOn = col_(t.headers, ['Show Backup','ShowBackup','Backup Show','Show Backup Boy','Use Backup','Backup Active','Backup On','Backup']);
    const cBk = col_(t.headers, ['Backup Delivery Boy','BackupDeliveryBoy','Backup Delivery Boy ID','Backup Boy','Backup Boy ID','BackupBoyID','Backup ID','Backup DeliveryBoyID']);
    t.rows.forEach(r => {
      const id = clean_(r[cId]).toUpperCase(); if (!id) return;
      const v = cOn >= 0 ? r[cOn] : '';
      out[id] = { on: v === true || /^(true|yes|y|1|✓|✔|tick|ticked|checked|on|show)$/i.test(clean_(v)), backup: cBk >= 0 ? clean_(r[cBk]).toUpperCase() : '' };
    });
  } catch (e) {}
  return (backupMap_.c = out);
}
// Who delivers this customer in this shift TODAY: the shift's boy - unless that boy has "Show Backup" ticked and a backup exists, then ONLY the backup boy.
function effectiveBoy_(cm) {
  const primary = clean_(cm.shiftBoyId).toUpperCase(), b = backupMap_()[primary];
  const backup = clean_(cm.backupBoyId).toUpperCase() || (b && b.backup) || '';
  if (b && b.on && backup) return { id:backup, backupOf:primary };
  return { id:primary, backupOf:'' };
}
function boyScheduleInfo_(profile) {
  const out = { weekOff: {}, shift: 'BOTH', showAll: false, showDemo: false };
  try {
    const t = table_(APP_CFG.SHEETS.boys); if (!t.headers.length) return out;
    const cId = col_(t.headers, ['DeliveryBoyID','Delivery Boy ID','Boy ID','Agent ID','Employee ID']);
    const cW = col_(t.headers, ['Week Off','WeekOff','Weekly Off','WeeklyOff','Off Day','Week Off Day','Day Off']);
    const cS = col_(t.headers, ['Shift','Shift Type','Shift Timing','Meal Shift','Duty','Duty Shift','Meal']);
    const cWS = col_(t.headers, ['Week Off Shift','WeekOff Shift','Weekly Off Shift','Week Off Meal','WeekOff Meal','Off Shift','Week Off Meal Type']);
    const cD = col_(t.headers, ['Show Demo','ShowDemo','Show Demos','Demo Show','Demo','Demo Access','Show Demo Customers']);
    const cA = col_(t.headers, ['Show Customer','Show Customers','ShowCustomer','ShowCustomers','Show All Customers','Show All Customer','All Customers','All Customer','Show Customer List','Customer List']);
    const row = t.rows.find(r => clean_(r[cId]).toUpperCase() === String(profile.id).toUpperCase());
    if (!row) return out;
    if (cW >= 0) out.weekOff = parseWeekOff_(row[cW], cWS >= 0 ? (/both|all/i.test(clean_(row[cWS])) ? null : mealsOf_(row[cWS])) : null);
    if (cS >= 0) {
      const s = clean_(row[cS]).toUpperCase(), L = /LUNCH/.test(s), D = /DINNER/.test(s);
      out.shift = (L && !D) ? 'LUNCH' : (D && !L) ? 'DINNER' : 'BOTH';
    }
    if (cD >= 0) { const v = row[cD]; out.showDemo = v === true || /^(true|yes|y|1|✓|✔|tick|ticked|checked|on|show)$/i.test(clean_(v)); }
    if (cA >= 0) { const v = row[cA]; out.showAll = v === true || /^(true|yes|y|1|✓|✔|tick|ticked|checked|all|show)$/i.test(clean_(v)); }
  } catch (e) {}
  return out;
}

/* ---------- Payment QR image (Settings1 -> "QR Code Image") ---------- */
function imageSrcFromCell_(sh, r, c) {
  const rg = sh.getRange(r, c); let url = '', v = null;
  const f = rg.getFormula();
  try { v = rg.getValue(); } catch (e) {}
  if (f && /IMAGE\s*\(/i.test(f)) {
    const m = f.match(/IMAGE\s*\(\s*"([^"]+)"/i), ref = f.match(/IMAGE\s*\(\s*\$?([A-Za-z]+\$?\d+)/);
    url = m ? m[1] : (ref ? String(sh.getRange(ref[1].replace(/\$/g, '')).getDisplayValue()).trim() : '');
  } else if (v && typeof v === 'object' && typeof v.getContentUrl === 'function') {      // image placed inside the cell
    let u = ''; try { u = v.getUrl() || ''; } catch (e) {}
    if (u) url = u; else {
      try {
        const resp = UrlFetchApp.fetch(v.getContentUrl(), { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
        if (resp.getResponseCode() === 200) return toDataUri_(resp.getBlob());
      } catch (e) {}
    }
  } else url = String(rg.getDisplayValue() || '').trim();
  if (!url) return '';
  const d = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=|thumbnail\?id=)([-\w]{20,})/) || url.match(/^([-\w]{28,})$/);
  if (d) { try { return toDataUri_(DriveApp.getFileById(d[1]).getBlob()); } catch (e) {} return 'https://drive.google.com/thumbnail?id=' + d[1] + '&sz=w1000'; }   // file is shared publicly
  if (/^data:image\//i.test(url)) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return '';
}
function toDataUri_(blob) {
  const type = blob.getContentType() || 'image/png';
  return 'data:' + type + ';base64,' + Utilities.base64Encode(blob.getBytes());
}
function getPaymentQr(token) {
  const profile = session_(token);
  if (!profile) return { ok:false, message:'Your session has expired. Please log in again.' };
  try {
    const sh = settingsSheet_();
    if (!sh) return { ok:false, message:'Settings1 sheet not found.' };
    const src = settingsSources_(sh); let img = '', upi = '';
    for (let i = 0; i < src.length && !img; i++) {
      const n = normHeader_(src[i].text);
      if (/qr/.test(n) && !/upi|id$/.test(n.replace(/qrcode|qrimage/g, ''))) img = imageSrcFromCell_(sh, src[i].r, src[i].c);
    }
    src.forEach(s => { if (!upi && /upi|vpa/.test(normHeader_(s.text)) && /@/.test(s.disp)) upi = clean_(s.disp); });
    if (!img) { try { const imgs = sh.getImages(); if (imgs.length) img = imgs[0].getUrl() || ''; } catch (e) {} }
    return img ? { ok:true, src:img, upi:upi } : { ok:false, upi:upi, message:'No QR Code Image found in Settings1.' };
  } catch (e) { return { ok:false, message:String(e && e.message || e) }; }
}

/* ---------- Attendance for the calendar screen ---------- */
function minutesOf_(v) {
  if (v instanceof Date && !isNaN(v)) return Number(Utilities.formatDate(v, APP_CFG.TIMEZONE, 'HH')) * 60 + Number(Utilities.formatDate(v, APP_CFG.TIMEZONE, 'mm'));
  return parseClock_(v);
}
function timeText_(v) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, APP_CFG.TIMEZONE, 'hh:mm a');
  return clean_(v);
}
/*  Rules
    PRESENT  punched in on or before the punch-in deadline (Settings1; default lunch 09:30, dinner 17:30)
    HALF     punched in AFTER the deadline (half day)
    LATE     only if the sheet status says "Late" (manual entry)
    ABSENT   no punch and the shift is over / day is past, or status Absent/Leave
    OFF      weekly off (day + shift), meal not in this boy's shift, or status Off/Holiday
    PENDING  today, shift not finished and no punch yet                                  */

function salaryAndHolidayInfo_(profile, monthKey, dim, todayKey, offMap) {
  const out = { monthlySalary:0, dailyRate:0, dateOfJoining:'', totalSalary:0, deduction:0, actualSalary:0, payableDays:0, holidays:{}, holidayNames:{} };
  try {
    const boysSheet = getSheet_(APP_CFG.SHEETS.boys);
    if (boysSheet && boysSheet.getLastRow() >= 2) {
      const values = boysSheet.getDataRange().getValues();
      const display = boysSheet.getDataRange().getDisplayValues();
      const headers = values[0].map(normHeader_);
      const findCol = aliases => {
        for (const a of aliases) { const i=headers.indexOf(normHeader_(a)); if(i>=0) return i; }
        return -1;
      };
      const idCol = findCol(['DeliveryBoyID','Delivery Boy ID','Boy ID','Agent ID','Employee ID']);
      let salCol = findCol(['Salary','Monthly Salary','Basic Salary','Fixed Salary','Monthly Salary ₹','Salary Per Month']);
      if (salCol < 0) salCol = headers.findIndex(h => h.includes('salary') && !/(incentive|advance|deduction|paid|balance)/.test(h));
      const dojCol = findCol(['Date of Joining','Joining Date','DOJ','Date Joined']);
      const wantedId = String(profile.id || '').trim().toUpperCase();
      let rowIndex = -1;
      for (let i=1;i<values.length;i++) {
        if (idCol>=0 && String(values[i][idCol] || '').trim().toUpperCase()===wantedId) { rowIndex=i; break; }
      }
      if (rowIndex>=0) {
        const rawSalary = salCol>=0 ? (values[rowIndex][salCol] || display[rowIndex][salCol]) : 0;
        out.monthlySalary = Number(String(rawSalary).replace(/[^0-9.\-]/g,'')) || 0;
        out.dateOfJoining = dojCol>=0 ? dateKeyFromCell_(values[rowIndex][dojCol] || display[rowIndex][dojCol]) : '';
      }
    }
  } catch(e) { Logger.log('Salary/DOJ lookup: ' + e); }

  // Monthly salary is the fixed contractual salary; deductions are calculated separately.
  // The 30-day basis is used only to derive the value of each meal shift.
  const join = out.dateOfJoining || (monthKey + '-01');
  const joinMonth = join.slice(0,7);
  const joinDay = joinMonth < monthKey ? 1 : (joinMonth > monthKey ? 31 : Math.min(30, Number(join.slice(8,10))));
  const endDay = monthKey < todayKey.slice(0,7) ? 30 : monthKey > todayKey.slice(0,7) ? 0 : Math.min(30, Number(todayKey.slice(8,10)));
  out.payableDays = Math.max(0, endDay - joinDay + 1);
  out.dailyRate = out.monthlySalary > 0 ? out.monthlySalary / 30 : 0;
  out.totalSalary = out.monthlySalary;

  // HOLIDAY LIST: continuous meal-by-meal interval, both endpoints inclusive, only ACTIVE rows.
  // Example: 05/11/2026 DINNER -> 07/11/2026 DINNER = 05 Lunch active; 05 Dinner holiday; 06 and 07 both meals holiday.
  // Sheet tab may be named "HOLIDAY LIST", "Holiday List", "Holidays" or "Holiday".
  // Optional name column: Reason / Holiday Name / Occasion / Name / Remark / Description.
  try {
    const hs = getSpreadsheet_().getSheets().filter(s =>
      ['holidaylist','holidays','holiday'].indexOf(normHeader_(s.getName())) >= 0)[0];
    if (hs && hs.getLastRow() >= 2) {
      const range = hs.getDataRange(), vals = range.getValues(), disp = range.getDisplayValues();
      const headers = vals[0].map(normHeader_);
      const find = aliases => { for (const a of aliases) { const i = headers.indexOf(normHeader_(a)); if (i >= 0) return i; } return -1; };
      const cFromDate = find(['FromDate','From Date']), cFromMeal = find(['FromMeal','From Meal']);
      const cToDate = find(['ToDate','To Date']),       cToMeal = find(['ToMeal','To Meal']);
      const cStatus = find(['Status']);
      const cReason = find(['Reason','Holiday Name','HolidayName','Occasion','Name','Remark','Remarks','Description']);
      const parseHolidayDate = (raw, shown) => {
        const t = String(shown || '').trim();
        let m = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
        if (m) return { y:+m[3], mo:+m[2], d:+m[1] };                 // DD/MM/YYYY
        m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (m) return { y:+m[1], mo:+m[2], d:+m[3] };
        if (raw instanceof Date && !isNaN(raw)) {
          const k = Utilities.formatDate(raw, APP_CFG.TIMEZONE, 'yyyy-MM-dd').split('-').map(Number);
          return { y:k[0], mo:k[1], d:k[2] };
        }
        const a = dateKeyFromCell_(shown || raw).match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return a ? { y:+a[1], mo:+a[2], d:+a[3] } : null;
      };
      // blank / BOTH / ALL meal: From -> LUNCH (whole day), To -> DINNER (whole day)
      const mealOr = (v, def) => { const m = normalizeMeal_(v); return (m === 'LUNCH' || m === 'DINNER') ? m : def; };
      const mealPoint = (dt, meal) => dt ? Math.floor(Date.UTC(dt.y, dt.mo - 1, dt.d) / 86400000) * 2 + (meal === 'DINNER' ? 1 : 0) : null;
      if (cFromDate >= 0 && cToDate >= 0) {
        const ym = monthKey.split('-').map(Number);
        const monthStart = Math.floor(Date.UTC(ym[0], ym[1] - 1, 1) / 86400000);
        const monthEnd   = Math.floor(Date.UTC(ym[0], ym[1] - 1, dim) / 86400000);
        for (let i = 1; i < vals.length; i++) {
          const status = cStatus >= 0 ? String(disp[i][cStatus] || vals[i][cStatus] || '').trim().toUpperCase() : 'ACTIVE';
          if (status && status !== 'ACTIVE') continue;
          const fromD = parseHolidayDate(vals[i][cFromDate], disp[i][cFromDate]);
          const toD   = parseHolidayDate(vals[i][cToDate],   disp[i][cToDate]);
          if (!fromD || !toD) continue;
          const from = mealPoint(fromD, cFromMeal >= 0 ? mealOr(disp[i][cFromMeal] || vals[i][cFromMeal], 'LUNCH')  : 'LUNCH');
          const to   = mealPoint(toD,   cToMeal   >= 0 ? mealOr(disp[i][cToMeal]   || vals[i][cToMeal],   'DINNER') : 'DINNER');
          if (to < from) continue;
          const reason = cReason >= 0 ? String(disp[i][cReason] || '').trim() : '';
          const firstDay = Math.max(monthStart, Math.floor(from / 2)), lastDay = Math.min(monthEnd, Math.floor(to / 2));
          for (let day = firstDay; day <= lastDay; day++) {
            const dk = Utilities.formatDate(new Date(day * 86400000), 'UTC', 'yyyy-MM-dd');
            ['LUNCH','DINNER'].forEach(meal => {
              const cur = day * 2 + (meal === 'DINNER' ? 1 : 0);
              if (cur >= from && cur <= to) {
                if (!out.holidays[dk]) out.holidays[dk] = [];
                if (out.holidays[dk].indexOf(meal) < 0) out.holidays[dk].push(meal);
                if (reason && !out.holidayNames[dk]) out.holidayNames[dk] = reason;
              }
            });
          }
        }
      } else Logger.log('HOLIDAY LIST needs headers FromDate and ToDate (FromMeal / ToMeal optional)');
    } else Logger.log('HOLIDAY LIST sheet missing or empty');
  } catch (e) { Logger.log('Holiday range lookup: ' + (e && e.stack || e)); }
  return out;
}
function getAttendance(token, month) {
  const profile = session_(token);
  if (!profile) return { ok:false, message:'Your session has expired. Please log in again.' };
  const tz = APP_CFG.TIMEZONE, now = new Date(), todayKey = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const nowMin = Number(Utilities.formatDate(now, tz, 'HH')) * 60 + Number(Utilities.formatDate(now, tz, 'mm'));
  const mk = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : todayKey.slice(0, 7);
  const cache = CacheService.getScriptCache();
  const cacheKey = 'att_v2_' + String(profile.id || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '_') + '_' + mk;
  const cached = cache.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch (e) { cache.remove(cacheKey); } }
  const y = Number(mk.slice(0, 4)), mo = Number(mk.slice(5, 7)), dim = new Date(y, mo, 0).getDate();
  const cfg = shiftConfig_(), sched = boyScheduleInfo_(profile);
  const offMap = hasKeys_(sched.weekOff) ? sched.weekOff : cfg.weekOff, shift = sched.shift;
  const shifts = {};
  ['LUNCH', 'DINNER'].forEach(m => { const c = cfg[m]; shifts[m] = { start:fmt12_(c.start), end:fmt12_(c.end), report:fmt12_(c.report), punchBy:fmt12_(c.punchBy) }; });
  const payInfo = salaryAndHolidayInfo_(profile, mk, dim, todayKey, offMap);
  const base = { ok:true, month:mk, today:todayKey, shifts:shifts, shift:shift, weekOff:weekOffList_(offMap), daysInMonth:dim };
  const sh = findAttendanceSheet_();
  if (!sh) {
    payInfo.actualSalary=payInfo.totalSalary;
    const missing = Object.assign(base, { found:false, days:[], salary:payInfo, summary:{ present:0, absent:0, late:0, half:0, total:dim } });
    cache.put(cacheKey, JSON.stringify(missing), 20);
    return missing;
  }

  const lc = sh.getLastColumn(), lr = sh.getLastRow();
  const hdr = sh.getRange(1, 1, 1, lc).getValues()[0].map(normHeader_), ix = n => hdr.indexOf(n);
  const cDate = ix('date'), cEmp = ix('employee') >= 0 ? ix('employee') : ix('employeename');
  const C = { LUNCH:{ st:ix('lunchstatus'), tm:ix('lunchcheckin') }, DINNER:{ st:ix('dinnerstatus'), tm:ix('dinnercheckin') } };
  const rng = lr > 1 ? sh.getRange(2, 1, lr - 1, lc) : null;
  const data = rng ? rng.getValues() : [], disp = rng ? rng.getDisplayValues() : [];      // display values keep times exact (no 1899 timezone drift)
  const me = [String(profile.id).toUpperCase(), String(profile.name).toUpperCase()];
  const byDay = {}; let first = '';
  data.forEach((r, i) => {
    if (me.indexOf(clean_(r[cEmp]).toUpperCase()) < 0) return;
    const dk = (r[cDate] instanceof Date && !isNaN(r[cDate])) ? Utilities.formatDate(r[cDate], tz, 'yyyy-MM-dd') : dateKeyFromCell_(r[cDate]);
    if (!dk) return; byDay[dk] = disp[i]; if (!first || dk < first) first = dk;
  });

  const mealState = (row, meal, dk, dow) => {
    const c = C[meal], inShift = shift === 'BOTH' || shift === meal, isOff = !!(offMap[dow] && offMap[dow][meal]);
    const st = row && c.st >= 0 ? clean_(row[c.st]).toLowerCase() : '';
    const tm = row && c.tm >= 0 ? clean_(row[c.tm]) : '';
    const o = { s:'', t:tm, why:'' }, punched = tm !== '' && parseClock_(tm) >= 0;
    if (!inShift) { o.s = 'OFF'; o.why = 'SHIFT'; return o; }
    if (isOff && !punched && !/present|late|half/.test(st)) { o.s = 'OFF'; o.why = 'WEEKOFF'; return o; }
    if (/off|holiday|weekly/.test(st) && !punched) { o.s = 'OFF'; o.why = 'HOLIDAY'; return o; }
    if (/absent|leave|no\s*show/.test(st) && !punched) { o.s = 'ABSENT'; return o; }
    if (punched) {
      const m = parseClock_(tm);
      if (/half/.test(st) || m > cfg[meal].punchBy) o.s = 'HALF';
      else if (/late/.test(st)) o.s = 'LATE';
      else o.s = 'PRESENT';
      return o;
    }
    if (/half/.test(st)) { o.s = 'HALF'; return o; }
    if (/late/.test(st)) { o.s = 'LATE'; return o; }
    if (/present/.test(st)) { o.s = 'PRESENT'; return o; }
    if (dk > todayKey) o.s = 'FUTURE';
    else if (first && dk < first) o.s = 'NODATA';
    else if (dk === todayKey) o.s = nowMin <= cfg[meal].end ? 'PENDING' : 'ABSENT';
    else o.s = 'ABSENT';
    return o;
  };
  const dayStatus = (a, b) => {
    const arr = [a.s, b.s].filter(s => s !== 'OFF');
    if (!arr.length) return 'OFF';
    if (arr.indexOf('ABSENT') >= 0) return 'ABSENT';
    if (arr.indexOf('HALF') >= 0) return 'HALF';
    if (arr.indexOf('LATE') >= 0) return 'LATE';
    if (arr.indexOf('PRESENT') >= 0) return 'PRESENT';
    return arr[0];
  };
  const sum = { present:0, absent:0, late:0, half:0, holiday:0, total:dim }, days = [];
  for (let d = 1; d <= dim; d++) {
    const dk = mk + '-' + ('0' + d).slice(-2), dow = new Date(y, mo - 1, d).getDay(), row = byDay[dk];
    const lu = mealState(row, 'LUNCH', dk, dow), di = mealState(row, 'DINNER', dk, dow);
    const holidayMeals = payInfo.holidays[dk] || [];
    [ ['LUNCH',lu], ['DINNER',di] ].forEach(pair => {
      const meal = pair[0], state = pair[1];
      if (payInfo.dateOfJoining && dk < payInfo.dateOfJoining) { state.s='OFF'; state.why='BEFORE_JOINING'; }
      else if (holidayMeals.indexOf(meal) >= 0) { state.s='OFF'; state.why='HOLIDAY'; state.t=''; }
    });
    let st = dayStatus(lu, di);
    if (st === 'OFF' && (lu.why === 'HOLIDAY' || di.why === 'HOLIDAY')) st = 'HOLIDAY';   // whole day is a holiday
    if (dk <= todayKey) {
      if (st === 'PRESENT') sum.present++; else if (st === 'ABSENT') sum.absent++; else if (st === 'LATE') sum.late++; else if (st === 'HALF') sum.half++;
    }
    // Show all holiday dates in the selected month, including upcoming holidays.
    if (lu.why==='HOLIDAY' || di.why==='HOLIDAY') sum.holiday++;
    days.push({ date:dk, dow:dow, lunch:lu, dinner:di, status:st, holidayName: payInfo.holidayNames[dk] || '' });
  }
  // Deduct only missed scheduled shifts: absent = one full shift; half day = half shift.
  // Weekly offs, holidays and dates before joining are paid and never deducted.
  let deduction = 0;
  days.forEach(d => {
    if (d.date > todayKey || (payInfo.dateOfJoining && d.date < payInfo.dateOfJoining)) return;
    [['LUNCH',d.lunch],['DINNER',d.dinner]].forEach(p => {
      const meal=p[0], x=p[1], dow=d.dow;
      if (x.why==='WEEKOFF' || x.why==='HOLIDAY' || x.why==='SHIFT' || x.why==='BEFORE_JOINING') return;
      const isScheduled = shift==='BOTH' || shift===meal;
      if (!isScheduled || (offMap[dow] && offMap[dow][meal])) return;
      if (x.s==='ABSENT') deduction += payInfo.dailyRate/2;
      else if (x.s==='HALF') deduction += payInfo.dailyRate/4;
    });
  });
  payInfo.deduction = Math.min(payInfo.totalSalary, deduction);
  payInfo.actualSalary = Math.max(0, payInfo.totalSalary - payInfo.deduction);
  const result = Object.assign(base, { found:true, days:days, summary:sum, salary:payInfo });
  cache.put(cacheKey, JSON.stringify(result), 20);
  return result;
}

/* ---------- Data model / header matching ---------- */
function customerColumns_(h) {
  return {id:col_(h,['CustomerID','Customer ID','Cust ID']),name:col_(h,['CustomerName','Customer Name','Name']),
    mobile:col_(h,['Mobile','Mobile No','Phone']),alt:col_(h,['AltMobile','Alternate Mobile','Alt Mobile']),
    address:col_(h,['LunchAddress','Lunch Address','Address','Location']),area:col_(h,['Area','Zone']),
    map:col_(h,['LunchGoogleMap','Lunch Google Map','MapLink','Map Link','Google Map']),
    dinnerAddress:col_(h,['DinnerAddress','Dinner Address']),dinnerMap:col_(h,['DinnerGoogleMap','Dinner Google Map']),
    boy:col_(h,['DeliveryBoyID','Delivery Boy ID','Boy ID','DeliveryBoy','Delivery Boy','Assigned Delivery Boy','Delivery Partner ID']),
    lunchBoy:col_(h,['LunchDeliveryBoyID','Lunch Delivery Boy ID','LunchDeliveryBoy','Lunch Delivery Boy','Lunch Boy ID','LunchBoyID']),
    dinnerBoy:col_(h,['DinnerDeliveryBoyID','Dinner Delivery Boy ID','DinnerDeliveryBoy','Dinner Delivery Boy','Dinner Boy ID','DinnerBoyID']),
    lunchQty:col_(h,['LunchQty','Lunch Qty']),
    dinnerQty:col_(h,['DinnerQty','Dinner Qty']),lunchOff:col_(h,['LunchWeekOff','Lunch Week Off']),
    dinnerOff:col_(h,['DinnerWeekOff','Dinner Week Off']),type:col_(h,['OrderType','Order Type','CustomerOrderType','Customer Order Type']),
    lunchType:col_(h,['LunchOrderType','Lunch Order Type','LunchCustomerOrderType']),
    lunchBackup:col_(h,['LunchBackup Delivery Boy','Lunch Backup Delivery Boy','LunchBackupDeliveryBoyID','Lunch Backup Delivery Boy ID','LunchBackupBoy']),
    dinnerBackup:col_(h,['Backup Delivery Boy','Dinner Backup Delivery Boy','DinnerBackupDeliveryBoy','DinnerBackup Delivery Boy','BackupDeliveryBoyID','Backup Delivery Boy ID']),
    lunchOptions:col_(h,['LUNCH CustomizedOptions','Lunch Customized Options','LunchCustomizedOptions','LunchCustomerCustomizedOptions']),mealType:col_(h,['MealType','Meal Type','CustomerMealType','Customer Meal Type']),
    start:col_(h,['StartDate','Start Date']),status:col_(h,['CustomerStatus','Customer Status','Status']),
    lunchOrder:col_(h,['LunchRouteOrder','Lunch Route Order','LunchRouteNo','Lunch Route No','LunchOrder','Lunch Order','LunchRoute','Lunch Route']),
    dinnerOrder:col_(h,['DinnerRouteOrder','Dinner Route Order','DinnerRouteNo','Dinner Route No','DinnerOrder','Dinner Order','DinnerRoute','Dinner Route']),
    options:col_(h,['CustomerCustomizedOptions','Customized Options','Customer Options'])};
}
function routeColumns_(h) {
  return {date:col_(h,['Date','Delivery Date']),meal:col_(h,['Meal','Meal Type']),qty:col_(h,['Qty','Quantity','Tiffin Qty','Tiffins']),
    boy:col_(h,['DeliveryBoyID','Delivery Boy ID','Delivery Boy','Boy ID']),type:col_(h,['Type','Customer Type','Order Type']),
    cid:col_(h,['CustomerID','Customer ID','Cust ID']),name:col_(h,['CustomerName','Customer Name','Customer']),
    mobile:col_(h,['Mobile','Mobile No','Phone']),location:col_(h,['Location','Area']),
    map:col_(h,['MapLink','Map Link','Google Map']),order:col_(h,['RouteOrder','Route Order','Order'])};
}
function deliveryColumns_(h) {
  return {id:col_(h,['Delivery ID','DeliveryID']),customer:col_(h,['Customer','CustomerID','Customer ID','CustomerName','Customer Name']),
    date:col_(h,['DeliveryDate','Delivery Date','Date']),meal:col_(h,['Meal','Meal Type']),
    required:col_(h,['RequiredQty','Required Qty','Required Quantity']),delivered:col_(h,['DeliveredQty','Delivered Qty','Delivered Quantity']),
    remaining:col_(h,['RemainingQty','Remaining Qty','Remaining Quantity']),status:col_(h,['Status','Delivery Status']),
    boy:col_(h,['DeliveryBoyID','Delivery Boy ID']),deliveredBy:col_(h,['Delivered By','DeliveredBy']),box:col_(h,['Box QR','BoxQR']),note:col_(h,['Remark','Remarks','Notes','Note']),time:col_(h,['Date Time','DateTime','Timestamp','Time','DeliveryTime','Delivery Time','Delivered At'])};
}
function requestColumns_(h) {
  return {cid:col_(h,['CustomerID','Customer ID','Cust ID']),name:col_(h,['CustomerName','Customer Name','Name']),
    type:col_(h,['RequestType','Request Type','Type']),from:col_(h,['FromDate','From Date']),
    fromMeal:col_(h,['FromMeal','From Meal']),to:col_(h,['ToDate','To Date']),toMeal:col_(h,['ToMeal','To Meal']),
    extraLunch:col_(h,['ExtraLunchQty','Extra Lunch Qty']),extraDinner:col_(h,['ExtraDinnerQty','Extra Dinner Qty']),
    cancelLunch:col_(h,['CancelLunchQty','Cancel Lunch Qty']),cancelDinner:col_(h,['CancelDinnerQty','Cancel Dinner Qty']),
    note:col_(h,['Remark','Remarks','Reason','Note']),status:col_(h,['Status','Request Status'])};
}
function customerObject_(r,c) {
  return {customerId:val_(r,c.id),customerName:val_(r,c.name),mobile:val_(r,c.mobile),altMobile:val_(r,c.alt),
    address:val_(r,c.address),area:val_(r,c.area),mapLink:val_(r,c.map),dinnerAddress:val_(r,c.dinnerAddress),
    dinnerMapLink:val_(r,c.dinnerMap),deliveryBoyId:val_(r,c.boy),lunchBoyId:val_(r,c.lunchBoy),dinnerBoyId:val_(r,c.dinnerBoy),lunchQty:num_(val_(r,c.lunchQty)),
    dinnerQty:num_(val_(r,c.dinnerQty)),lunchWeekOff:val_(r,c.lunchOff),dinnerWeekOff:val_(r,c.dinnerOff),
    orderType:val_(r,c.type),mealType:val_(r,c.mealType),startDate:dateKeyFromCell_(val_(r,c.start)),customerStatus:val_(r,c.status),
    lunchRouteOrder:val_(r,c.lunchOrder),dinnerRouteOrder:val_(r,c.dinnerOrder),options:val_(r,c.options),
    // shift-specific columns (LUNCH uses the Lunch… columns, DINNER uses the Dinner… / plain columns)
    lunchOrderType:c.lunchType>=0?val_(r,c.lunchType):val_(r,c.type),
    lunchOptions:c.lunchOptions>=0?val_(r,c.lunchOptions):val_(r,c.options),
    lunchBackupBoyId:val_(r,c.lunchBackup),dinnerBackupBoyId:val_(r,c.dinnerBackup)};
}
// The customer as seen in ONE shift: LUNCH -> Lunch columns, DINNER -> Dinner columns (falls back to the shared columns only when a shift column is empty/missing).
function forMeal_(c, m) {
  const L = (m === 'LUNCH'), o = Object.assign({}, c);
  o.address       = L ? c.address : (c.dinnerAddress || c.address);
  o.mapLink       = L ? c.mapLink : (c.dinnerMapLink || c.mapLink);
  o.orderType     = L ? (c.lunchOrderType || c.orderType) : c.orderType;
  o.options       = L ? c.lunchOptions : c.options;
  o.weekOff       = L ? c.lunchWeekOff : c.dinnerWeekOff;
  o.backupBoyId   = L ? c.lunchBackupBoyId : c.dinnerBackupBoyId;
  o.shiftBoyId    = L ? (c.lunchBoyId || c.deliveryBoyId) : (c.dinnerBoyId || c.deliveryBoyId);
  o.routeOrder    = L ? c.lunchRouteOrder : c.dinnerRouteOrder;
  return o;
}
// true when this customer's Lunch/Dinner week-off column names the weekday of the delivery date (e.g. "Sunday", "Sun, Wed")
function isCustomerOffToday_(weekOffText, dateKey) {
  const t = String(weekOffText || '').toLowerCase(); if (!t.trim()) return false;
  const d = new Date(Number(dateKey.slice(0,4)), Number(dateKey.slice(5,7)) - 1, Number(dateKey.slice(8,10)));
  const names = ['sun','mon','tue','wed','thu','fri','sat'];
  return new RegExp('\\b' + names[d.getDay()] + '[a-z]*').test(t);
}
// RouteOrder typed in the ROUTE sheet for this DATE + SHIFT overrides the CUSTOMER-sheet order for that shift only.
function routeOrderOverrides_(routeTable, R, target) {
  const out = {};
  routeTable.rows.forEach(r => {
    if (R.order < 0 || R.cid < 0) return;
    if (dateKeyFromCell_(val_(r, R.date)) !== target) return;
    const o = val_(r, R.order); if (o === '') return;
    out[key_(val_(r, R.cid), normalizeMeal_(val_(r, R.meal)))] = o;
  });
  return out;
}
function routeCustomerObject_(r,R,cid) {
  const name=val_(r,R.name);
  if (!cid && !name) return null;
  return {customerId:cid || name,customerName:name || cid,mobile:val_(r,R.mobile),altMobile:'',
    address:val_(r,R.location),area:val_(r,R.location),mapLink:val_(r,R.map),dinnerAddress:'',
    dinnerMapLink:'',deliveryBoyId:val_(r,R.boy),lunchQty:0,dinnerQty:0,orderType:val_(r,R.type),
    lunchRouteOrder:val_(r,R.order),dinnerRouteOrder:val_(r,R.order),options:''};
}
function buildRequests_(t,Q,target) {
  const out={};
  t.rows.forEach(r=>{
    const cid=val_(r,Q.cid).toUpperCase(); if(!cid) return;
    const from=dateKeyFromCell_(val_(r,Q.from)); const to=dateKeyFromCell_(val_(r,Q.to)) || from;
    if (!from || target < from || target > to) return;
    if (Q.status>=0 && /^(rejected|declined|cancelled by admin|inactive)$/i.test(val_(r,Q.status))) return;
    const fromMeal=normalizeMeal_(val_(r,Q.fromMeal)); const toMeal=normalizeMeal_(val_(r,Q.toMeal));
    ['LUNCH','DINNER'].forEach(m=>{
      const mealMatches = fromMeal==='ALL' || fromMeal===m || toMeal===m ||
        (fromMeal==='LUNCH' && toMeal==='DINNER' && m==='DINNER') ||
        (fromMeal==='DINNER' && toMeal==='LUNCH' && m==='LUNCH');
      if(!mealMatches) return;
      const type=val_(r,Q.type).toUpperCase();
      const extra=num_(val_(r,m==='LUNCH'?Q.extraLunch:Q.extraDinner));
      const cancel=num_(val_(r,m==='LUNCH'?Q.cancelLunch:Q.cancelDinner));
      const cancellation = cancel>0 || /CANCEL|SKIP|STOP/.test(type);
      const k=key_(cid,m); if(!out[k]) out[k]=emptyRequest_();
      if(cancellation) { out[k].cancelQty=Math.max(out[k].cancelQty,cancel); if(cancel>0) out[k].cancelled=true; }
      if(extra>0) out[k].extraQty+=extra;
      if(/CANCEL|SKIP|STOP/.test(type) && cancel===0) out[k].cancelled=true;
      out[k].note=val_(r,Q.note) || out[k].note;
    });
  });
  return out;
}
function buildDeliveryMap_(t,D,target,customersById) {
  const out={};
  t.rows.forEach(r=>{
    if(dateKeyFromCell_(val_(r,D.date))!==target) return;
    const meal=normalizeMeal_(val_(r,D.meal)); if(meal!=='LUNCH'&&meal!=='DINNER') return;
    let customer=val_(r,D.customer).toUpperCase();
    if (!customer) return;
    if (!customersById[customer]) {
      const match = Object.keys(customersById).find(id =>
        String(customersById[id].customerName || '').trim().toUpperCase() === customer
      );
      if (match) customer = match;
    }
    const status=val_(r,D.status) || ((D.note>=0 && /not available/i.test(val_(r,D.note))) ? 'Not Available' : '');
    const deliveredRaw=val_(r,D.delivered);
    let delivered = num_(deliveredRaw);
    if (/^DELIVERED$/i.test(deliveredRaw)) {
      const req=num_(val_(r,D.required)); delivered=req || 1;
    }
    const k=key_(customer,meal);
    if(!out[k]) out[k]={deliveredQty:0,status:'',deliveryId:'',remainingQty:0};
    out[k].deliveredQty+=delivered;
    out[k].status=status || (/^DELIVERED$/i.test(deliveredRaw)?'Delivered':'');
    out[k].deliveryId=val_(r,D.id) || out[k].deliveryId;
  });
  return out;
}
// DEMO sheet -> normalised rows for one date. A row with a DeliveryBoyID is shown only to that boy; a row without one is shown to every boy who has "Show Demo" ticked.
// Payment cell -> 'PAID' or 'PENDING' (blank / unknown = pending)
function payState_(v) {
  const x = clean_(v).toLowerCase();
  if (!x) return 'PENDING';
  if (/unpaid|not paid|pending|\bdue\b|^(0|no|n|false)$/.test(x)) return 'PENDING';
  return /paid|done|received|success|complete|yes|true|ok|online|cash|upi/.test(x) ? 'PAID' : 'PENDING';
}
function demoRows_(t, boy, target) {
  const h = t.headers, out = [];
  const dc = {
    date:col_(h,['Date','Demo Date','DemoDate','Delivery Date','Trial Date']),
    meal:col_(h,['Meal','Meal Type','MealType','Shift','Demo Meal','Demo Shift']),
    boy:col_(h,['DeliveryBoyID','Delivery Boy ID','Delivery Boy','DeliveryBoy','Boy ID']),
    order:col_(h,['RouteOrder','Route Order','Order']),
    cid:col_(h,['CustomerID','Customer ID','Cust ID','DemoID','Demo ID']),
    name:col_(h,['CustomerName','Customer Name','Demo Customer','Demo Customer Name','DemoCustomer','Name','Customer','Demo Name','Name of Customer','Party Name','Lead Name']),
    mobile:col_(h,['Mobile','Mobile No','Mobile Number','Phone','Contact','Contact No','WhatsApp']),
    address:col_(h,['Address','Location','Area']),
    map:col_(h,['MapLink','Map Link','Google Map','GoogleMap']),
    qty:col_(h,['No of Demos','No. of Demos','No Of Demo','Number of Demos','No of Tiffins','No. of Tiffins','Demo Qty','Demo Tiffins','No of Demo Tiffins','Qty','Quantity','Tiffin Qty','Tiffins']),
    status:col_(h,['Status','Demo Status']),
    note:col_(h,['Remark','Remarks','Note','Notes']),
    pay:col_(h,['Demo Payment Status','DemoPaymentStatus','Payment Status','PaymentStatus','Pay Status','Payment','Payment Received','Paid','Paid Status']),
    amount:col_(h,['Amount','Demo Amount','Payment Amount','Fees','Total Amount','Amount Due'])
  };
  if (dc.date < 0) return out;
  t.rows.forEach(r => {
    if (dateKeyFromCell_(val_(r,dc.date)) !== target) return;
    const rb = val_(r,dc.boy).toUpperCase(); if (rb && rb !== String(boy).toUpperCase()) return;
    if (/cancel|reject|inactive|closed/i.test(val_(r,dc.status))) return;
    const name = val_(r,dc.name), cid = (val_(r,dc.cid) || name).toUpperCase(); if (!cid) return;
    const mraw = val_(r,dc.meal).toUpperCase(), L = mraw.indexOf('LUNCH') >= 0, D = mraw.indexOf('DINNER') >= 0;
    const meals = (L && !D) ? ['LUNCH'] : (D && !L) ? ['DINNER'] : ['LUNCH','DINNER'];      // blank / BOTH / ALL = both meals
    out.push({ cid:cid, name:name || cid, mobile:val_(r,dc.mobile), address:val_(r,dc.address), map:val_(r,dc.map), order:val_(r,dc.order),
      qty:Math.max(1, num_(val_(r,dc.qty)) || 1), meals:meals, note:val_(r,dc.note), payment:payState_(val_(r,dc.pay)), paymentAmount:num_(val_(r,dc.amount)) });
  });
  return out;
}
function addDemoItems_(items,t,boy,target,mealFilter,reqs,dels) {
  demoRows_(t, boy, target).forEach(d => d.meals.forEach(m => {
    if (mealFilter !== 'ALL' && m !== mealFilter) return;
    const q = reqs[key_(d.cid,m)] || emptyRequest_(); if (q.cancelled) return;
    const del = dels[key_(d.cid,m)] || {}, need = Math.max(0, d.qty + q.extraQty - q.cancelQty);
    items.push({ customerId:d.cid, customerName:d.name, mobile:d.mobile, altMobile:'', address:d.address, dinnerAddress:d.address, area:d.address,
      mapLink:d.map, dinnerMapLink:d.map, meal:m, routeOrder:d.order, type:'DEMO', requiredQty:need, extraQty:q.extraQty, cancelQty:q.cancelQty,
      deliveredQty:del.deliveredQty || 0, remainingQty:Math.max(0, need - (del.deliveredQty || 0)), deliveryStatus:del.status || '',
      deliveryId:del.deliveryId || '', requestNote:q.note || d.note || '', payment:d.payment, paymentAmount:d.paymentAmount || 0, deliveryBoyId:boy });
  }));
}
// Table for the Demo card on the home screen (all demo rows of the date, both meals).
function getDemoList(token, requestedDate) {
  const profile = session_(token);
  if (!profile) return { ok:false, message:'Your session has expired. Please log in again.' };
  if (!boyScheduleInfo_(profile).showDemo) return { ok:true, enabled:false, rows:[] };
  const target = parseDateKey_(requestedDate) || dateKey_(new Date());
  const dt = table_(APP_CFG.SHEETS.demo);
  if (!dt.headers.length) return { ok:true, enabled:true, found:false, date:target, rows:[] };
  const delTable = table_(APP_CFG.SHEETS.deliveries), dels = buildDeliveryMap_(delTable, deliveryColumns_(delTable.headers), target, {});
  const rows = [];
  demoRows_(dt, profile.id, target).forEach(d => d.meals.forEach(m => {
    const del = dels[key_(d.cid, m)] || {};
    rows.push({ customerId:d.cid, customerName:d.name, mobile:d.mobile, address:d.address, meal:m, routeOrder:d.order, qty:d.qty, note:d.note, payment:d.payment, paymentAmount:d.paymentAmount || 0,
      status:(del.deliveredQty || 0) > 0 ? 'DELIVERED' : 'PENDING' });
  }));
  rows.sort((a,b) => (a.meal === b.meal ? 0 : (a.meal === 'LUNCH' ? -1 : 1)) || numberSort_(a.routeOrder) - numberSort_(b.routeOrder) || String(a.customerName).localeCompare(String(b.customerName)));
  return { ok:true, enabled:true, found:true, date:target, rows:rows };
}
function mergeItem_(c,x) { return Object.assign({},c,x,{customerId:c.customerId,customerName:c.customerName,deliveryBoyId:c.deliveryBoyId}); }
function emptyRequest_(){return {extraQty:0,cancelQty:0,cancelled:false,note:''};}
function dedupeItems_(items) {
  const map={};
  items.forEach(x=>{
    const k=key_(x.customerId,x.meal);
    if(!map[k]) map[k]=x;
    else {
      map[k].requiredQty=Math.max(map[k].requiredQty||0,x.requiredQty||0);
      map[k].extraQty=Math.max(map[k].extraQty||0,x.extraQty||0);
      if(numberSort_(x.routeOrder)<numberSort_(map[k].routeOrder)) map[k].routeOrder=x.routeOrder;
    }
  });
  return Object.keys(map).map(k=>map[k]);
}

/* ---------- Utilities ---------- */
function session_(token) {
  if(!token) return null;
  try { return JSON.parse(CacheService.getScriptCache().get('db_session_'+String(token)) || 'null'); }
  catch(e){return null;}
}
let _SS_ = null, _TC_ = {};                      // live only for ONE server call: avoids re-opening the spreadsheet / re-reading sheets
function getSpreadsheet_() {
  return _SS_ || (_SS_ = SpreadsheetApp.openById(APP_CFG.SPREADSHEET_ID));
}
function getSheet_(name) {
  return getSpreadsheet_().getSheetByName(name);
}
function table_(name){ if (_TC_[name]) return _TC_[name]; const s=getSheet_(name); return (_TC_[name] = s?readTable_(s):{headers:[],rows:[]}); }
function readTable_(s){
  const values=s.getDataRange().getValues();
  if(!values.length) return {headers:[],rows:[]};
  const headers=values[0].map(v=>String(v||'').trim());
  return {headers:headers,rows:values.slice(1).filter(r=>r.some(v=>v!==''&&v!==null))};
}
function col_(headers,aliases){
  const normHeaders=headers.map(h=>normHeader_(h));
  for(const a of aliases){const i=normHeaders.indexOf(normHeader_(a));if(i>=0)return i;}
  return -1;
}
function normHeader_(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');}
function val_(r,i){return i>=0&&i<r.length?clean_(r[i]):'';}
function clean_(v){return String(v===null||v===undefined?'':v).trim();}
function num_(v){if(typeof v==='number')return isFinite(v)?v:0;const n=parseFloat(String(v||'').replace(/,/g,''));return isFinite(n)?n:0;}
function normalizeMeal_(v){const s=String(v||'').trim().toUpperCase();if(s.indexOf('LUNCH')>=0)return 'LUNCH';if(s.indexOf('DINNER')>=0)return 'DINNER';return s||'ALL';}
function key_(id,meal){return String(id||'').trim().toUpperCase()+'|'+normalizeMeal_(meal);}
function mealEnabled_(v){return num_(v)>0 || /^(YES|Y|TRUE|✓|✔)$/i.test(String(v||'').trim());}
function numberSort_(v){const n=parseFloat(String(v||'').replace(/[^\d.-]/g,''));return isFinite(n)?n:999999;}
function dateKey_(d){return Utilities.formatDate(d,Session.getScriptTimeZone(),'yyyy-MM-dd');}
function parseDateKey_(s){const m=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?m[1]+'-'+m[2]+'-'+m[3]:'';}
function dateKeyFromCell_(v){
  if(v instanceof Date && !isNaN(v)) return dateKey_(v);
  const s=String(v||'').trim(); if(!s)return '';
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m)return m[1]+'-'+m[2]+'-'+m[3];
  m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if(m)return m[3]+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[1]).slice(-2);
  m=s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/); if(m)return m[3]+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[1]).slice(-2);
  const d=new Date(s); return isNaN(d)?'':dateKey_(d);
}
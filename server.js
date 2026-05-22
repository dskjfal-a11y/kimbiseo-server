import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const IMWEB_API_KEY = process.env.IMWEB_API_KEY;
const IMWEB_SECRET_KEY = process.env.IMWEB_SECRET_KEY;
const ORDER_VERSION = process.env.ORDER_VERSION || "v2";

const SUBSCRIPTION_KEYWORDS = (process.env.SUBSCRIPTION_KEYWORDS || "정기구독")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const PAID_SERVICE_KEYWORDS = (process.env.PAID_SERVICE_KEYWORDS || "유료")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const DATA_DIR = path.join(process.cwd(), "data");
const PAYMENT_REQUEST_FILE = path.join(DATA_DIR, "payment-requests.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

function readJsonFile(filePath, defaultValue) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return defaultValue;
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^0-9]/g, "");
}

function toKoreaDateStringFromUnix(unixSeconds) {
  if (!unixSeconds) return null;
  const date = new Date(Number(unixSeconds) * 1000);
  const korea = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return korea.toISOString().slice(0, 10);
}

function toKoreaDateTimeStringFromUnix(unixSeconds) {
  if (!unixSeconds) return null;
  const date = new Date(Number(unixSeconds) * 1000);
  const korea = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return korea.toISOString().replace("T", " ").slice(0, 19);
}

function parseKoreaDateToUtcDate(dateString) {
  const [y, m, d] = dateString.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, -9, 0, 0));
}

function addCalendarOneMonth(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);

  const targetMonthFirst = new Date(Date.UTC(year, month, 1));
  const targetYear = targetMonthFirst.getUTCFullYear();
  const targetMonth = targetMonthFirst.getUTCMonth();

  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const validDay = Math.min(day, lastDayOfTargetMonth);

  const mm = String(targetMonth + 1).padStart(2, "0");
  const dd = String(validDay).padStart(2, "0");

  return `${targetYear}-${mm}-${dd}`;
}

function isDateWithinInclusive(todayDate, startDate, endDate) {
  return todayDate >= startDate && todayDate <= endDate;
}

function nowKoreaDateString() {
  const now = new Date();
  const korea = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return korea.toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function sameOrAfterMinute(paymentUnixSeconds, sentAtIso) {
  if (!paymentUnixSeconds || !sentAtIso) return false;

  const paymentDate = new Date(Number(paymentUnixSeconds) * 1000);
  const sentDate = new Date(sentAtIso);

  const paymentMinute = Math.floor(paymentDate.getTime() / 60000);
  const sentMinute = Math.floor(sentDate.getTime() / 60000);

  return paymentMinute >= sentMinute;
}

function includesAnyKeyword(text, keywords) {
  const value = String(text || "");
  return keywords.some((keyword) => value.includes(keyword));
}

async function imwebFetch(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);

  if (!response.ok || !data) {
    throw new Error(`아임웹 API 호출 실패: ${response.status} ${JSON.stringify(data)}`);
  }

  if (data.code && Number(data.code) !== 200) {
    throw new Error(`아임웹 API 오류: ${JSON.stringify(data)}`);
  }

  return data;
}

let cachedToken = null;

async function getImwebAccessToken() {
  if (cachedToken) return cachedToken;

  const url = `https://api.imweb.me/v2/auth?key=${encodeURIComponent(
    IMWEB_API_KEY
  )}&secret=${encodeURIComponent(IMWEB_SECRET_KEY)}`;

  const data = await imwebFetch(url, { method: "GET" });

  if (!data.access_token) {
    throw new Error(`아임웹 access_token 없음: ${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;
  return cachedToken;
}

async function callImwebApi(url) {
  const token = await getImwebAccessToken();

  try {
    return await imwebFetch(url, {
      method: "GET",
      headers: {
        "access-token": token
      }
    });
  } catch (error) {
    cachedToken = null;
    const newToken = await getImwebAccessToken();

    return await imwebFetch(url, {
      method: "GET",
      headers: {
        "access-token": newToken
      }
    });
  }
}

async function getMembers() {
  const url = "https://api.imweb.me/v2/member/members";
  const data = await callImwebApi(url);

  const list = data?.data?.list || data?.data || [];
  return Array.isArray(list) ? list : [];
}

async function getOrders() {
  const url = `https://api.imweb.me/v2/shop/orders?order_version=${encodeURIComponent(ORDER_VERSION)}`;
  const data = await callImwebApi(url);

  const list = data?.data?.list || data?.data || [];
  return Array.isArray(list) ? list : [];
}

async function getProductOrders(orderNo) {
  const url = `https://api.imweb.me/v2/shop/orders/${encodeURIComponent(
    orderNo
  )}/prod-orders?order_version=${encodeURIComponent(ORDER_VERSION)}`;

  const data = await callImwebApi(url);
  return Array.isArray(data?.data) ? data.data : [];
}

function findMember(members, input) {
  const inputName = String(input.name || "").trim();
  const inputEmail = String(input.email || "").trim().toLowerCase();
  const inputPhone = normalizePhone(input.phone);

  return members.find((member) => {
    const memberName = String(member.name || "").trim();
    const memberEmail = String(member.email || member.uid || "").trim().toLowerCase();
    const memberPhone = normalizePhone(member.callnum);

    if (inputPhone && memberPhone && inputPhone === memberPhone) return true;
    if (inputEmail && memberEmail && inputEmail === memberEmail) return true;
    if (inputName && memberName && inputName === memberName) return true;

    return false;
  });
}

function filterOrdersByMember(orders, member, input) {
  const memberCode = member?.member_code;
  const phone = normalizePhone(input.phone || member?.callnum);
  const email = String(input.email || member?.email || "").trim().toLowerCase();
  const name = String(input.name || member?.name || "").trim();

  return orders.filter((order) => {
    const orderer = order.orderer || {};
    const orderMemberCode = orderer.member_code;
    const orderPhone = normalizePhone(orderer.call);
    const orderEmail = String(orderer.email || "").trim().toLowerCase();
    const orderName = String(orderer.name || "").trim();

    if (memberCode && orderMemberCode && memberCode === orderMemberCode) return true;
    if (phone && orderPhone && phone === orderPhone) return true;
    if (email && orderEmail && email === orderEmail) return true;
    if (name && orderName && name === orderName) return true;

    return false;
  });
}

async function enrichOrdersWithProducts(orders) {
  const result = [];

  for (const order of orders) {
    if (!order.order_no) continue;

    try {
      const productOrders = await getProductOrders(order.order_no);
      result.push({
        ...order,
        productOrders
      });
    } catch (error) {
      result.push({
        ...order,
        productOrders: [],
        productOrderError: error.message
      });
    }
  }

  return result;
}

function flattenPaidItems(enrichedOrders) {
  const items = [];

  for (const order of enrichedOrders) {
    for (const prodOrder of order.productOrders || []) {
      const status = prodOrder.status || "";
      const payTime = prodOrder.pay_time || order?.payment?.payment_time || order.order_time;

      for (const item of prodOrder.items || []) {
        items.push({
          orderNo: order.order_no,
          prodOrderNo: prodOrder.order_no,
          status,
          payTime,
          payDate: toKoreaDateStringFromUnix(payTime),
          payDateTime: toKoreaDateTimeStringFromUnix(payTime),
          prodName: item.prod_name || "",
          price: item?.payment?.price || item?.payment?.payment_amount || order?.payment?.payment_amount || 0,
          raw: item
        });
      }
    }
  }

  return items;
}

function judgeSubscription(paidItems) {
  const subscriptionItems = paidItems
    .filter((item) => item.status === "COMPLETE")
    .filter((item) => includesAnyKeyword(item.prodName, SUBSCRIPTION_KEYWORDS))
    .sort((a, b) => Number(b.payTime || 0) - Number(a.payTime || 0));

  const latest = subscriptionItems[0];

  if (!latest || !latest.payDate) {
    return {
      subscriptionActive: false,
      subscriptionPaidDate: null,
      subscriptionValidUntil: null,
      subscriptionProduct: null,
      reason: "정기구독 결제완료 내역이 없습니다."
    };
  }

  const paidDate = latest.payDate;
  const validUntil = addCalendarOneMonth(paidDate);
  const today = nowKoreaDateString();

  const active = isDateWithinInclusive(today, paidDate, validUntil);

  return {
    subscriptionActive: active,
    subscriptionPaidDate: paidDate,
    subscriptionValidUntil: validUntil,
    subscriptionProduct: latest.prodName,
    subscriptionOrderNo: latest.orderNo,
    reason: active
      ? "정기구독 결제일 기준 다음 달 같은 날짜까지 유효합니다."
      : "정기구독 유효기간이 지났습니다."
  };
}

function getLatestPaymentRequest(customerKey) {
  const records = readJsonFile(PAYMENT_REQUEST_FILE, []);
  const matched = records
    .filter((record) => record.customerKey === customerKey)
    .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());

  return matched[0] || null;
}

function judgePaidService(paidItems, paymentRequest) {
  if (!paymentRequest) {
    return {
      paidServiceCompleted: false,
      paymentLinkSentAt: null,
      paidServicePaidAt: null,
      paidServiceProduct: null,
      reason: "유료 서비스 결제창 발송 기록이 없습니다."
    };
  }

  const paidServiceItems = paidItems
    .filter((item) => item.status === "COMPLETE")
    .filter((item) => sameOrAfterMinute(item.payTime, paymentRequest.sentAt))
    .filter((item) => {
      if (paymentRequest.productKeyword) {
        return item.prodName.includes(paymentRequest.productKeyword);
      }

      return includesAnyKeyword(item.prodName, PAID_SERVICE_KEYWORDS);
    })
    .sort((a, b) => Number(b.payTime || 0) - Number(a.payTime || 0));

  const latest = paidServiceItems[0];

  if (!latest) {
    return {
      paidServiceCompleted: false,
      paymentLinkSentAt: paymentRequest.sentAt,
      paidServicePaidAt: null,
      paidServiceProduct: null,
      reason: "결제창 발송 시각 이후 유료 서비스 결제완료 내역이 없습니다."
    };
  }

  return {
    paidServiceCompleted: true,
    paymentLinkSentAt: paymentRequest.sentAt,
    paidServicePaidAt: latest.payDateTime,
    paidServiceProduct: latest.prodName,
    paidServiceOrderNo: latest.orderNo,
    reason: "결제창 발송 시각 이후 유료 서비스 결제완료가 확인되었습니다."
  };
}

function makeCustomerKey(input, member) {
  const phone = normalizePhone(input.phone || member?.callnum);
  const email = String(input.email || member?.email || "").trim().toLowerCase();
  const name = String(input.name || member?.name || "").trim();

  if (phone) return `phone:${phone}`;
  if (email) return `email:${email}`;
  if (member?.member_code) return `member:${member.member_code}`;
  if (name) return `name:${name}`;

  return "unknown";
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "kimbiseo-server",
    time: nowIso()
  });
});

app.post("/payment-link/sent", (req, res) => {
  const body = req.body || {};

  const customerKey = makeCustomerKey(body, null);

  const records = readJsonFile(PAYMENT_REQUEST_FILE, []);

  const record = {
    id: `pr_${Date.now()}`,
    customerKey,
    name: body.name || "",
    phone: body.phone || "",
    email: body.email || "",
    productKeyword: body.productKeyword || "",
    paymentLink: body.paymentLink || "",
    sentAt: nowIso()
  };

  records.push(record);
  writeJsonFile(PAYMENT_REQUEST_FILE, records);

  res.json({
    ok: true,
    message: "유료 서비스 결제창 발송 시각을 기록했습니다.",
    paymentRequest: record
  });
});

app.post("/customer-profile", async (req, res) => {
  try {
    const input = req.body || {};

    const members = await getMembers();
    const member = findMember(members, input);

    if (!member) {
      return res.json({
        ok: true,
        isMember: false,
        canUseService: false,
        subscriptionActive: false,
        paidServiceCompleted: false,
        reason: "아임웹 회원정보에서 고객을 찾지 못했습니다.",
        input
      });
    }

    const allOrders = await getOrders();
    const customerOrders = filterOrdersByMember(allOrders, member, input);
    const enrichedOrders = await enrichOrdersWithProducts(customerOrders);
    const paidItems = flattenPaidItems(enrichedOrders);

    const subscription = judgeSubscription(paidItems);

    const customerKey = makeCustomerKey(input, member);
    const latestPaymentRequest = getLatestPaymentRequest(customerKey);
    const paidService = judgePaidService(paidItems, latestPaymentRequest);

    const canUseSubscriptionService = subscription.subscriptionActive;

    res.json({
      ok: true,
      isMember: true,
      member: {
        memberCode: member.member_code,
        uid: member.uid,
        name: member.name,
        email: member.email,
        phone: member.callnum,
        joinTime: member.join_time,
        grade: member.member_grade
      },
      subscription,
      paidService,
      canUseSubscriptionService,
      canProceedPaidService: paidService.paidServiceCompleted,
      recentOrders: customerOrders.slice(0, 5).map((order) => ({
        orderNo: order.order_no,
        orderTime: toKoreaDateTimeStringFromUnix(order.order_time),
        orderer: order.orderer,
        payment: order.payment
      })),
      messageForAgent: buildMessageForAgent(subscription, paidService)
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

function buildMessageForAgent(subscription, paidService) {
  if (subscription.subscriptionActive && paidService.paidServiceCompleted) {
    return "정기구독이 유효하고, 유료 서비스 결제도 완료되었습니다.";
  }

  if (subscription.subscriptionActive && !paidService.paidServiceCompleted) {
    return "정기구독은 유효합니다. 단, 이번 요청이 유료 서비스라면 유료 결제 완료 여부는 아직 확인되지 않았습니다.";
  }

  if (!subscription.subscriptionActive && paidService.paidServiceCompleted) {
    return "정기구독은 유효하지 않지만, 유료 서비스 결제는 완료되었습니다.";
  }

  return "정기구독 유효 결제와 유료 서비스 결제완료가 확인되지 않았습니다.";
}

app.post("/orders/create", (req, res) => {
  const body = req.body || {};
  const orders = readJsonFile(ORDERS_FILE, []);

  const order = {
    id: `order_${Date.now()}`,
    createdAt: nowIso(),
    status: "received",
    customerName: body.customerName || body.name || "미확인",
    phone: body.phone || "미확인",
    requestSummary: body.requestSummary || "",
    taskType: body.taskType || "",
    place: body.place || "",
    deadline: body.deadline || "",
    item: body.item || "",
    budget: body.budget || "",
    deliveryPlace: body.deliveryPlace || "",
    photoRequired: body.photoRequired || "",
    priceType: body.priceType || "",
    conversationSummary: body.conversationSummary || "",
    raw: body
  };

  orders.push(order);
  writeJsonFile(ORDERS_FILE, orders);

  res.json({
    ok: true,
    message: "오더를 저장했습니다.",
    order
  });
});

app.get("/orders", (req, res) => {
  const orders = readJsonFile(ORDERS_FILE, []);
  res.json({
    ok: true,
    count: orders.length,
    orders: orders.slice().reverse()
  });
});

app.listen(PORT, () => {
  console.log(`Kimbiseo server running on port ${PORT}`);
});
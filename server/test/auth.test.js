// 认证中间件测试。进入 server 目录后运行：node --test test/auth.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../modules/User');
const { requireAuth } = require('../middleware/auth');

// 创建一个轻量的响应对象，模拟 Express 的 res.status/json/clearCookie。
// 这样测试中间件时不需要启动服务器。
function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    clearedCookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    clearCookie(name) {
      this.clearedCookies.push(name);
      return this;
    }
  };
}

// 模拟一次访问受保护接口的请求。测试可传入不同会话或覆盖默认请求字段。
function makeRequest(session, overrides = {}) {
  return {
    method: 'GET',
    baseUrl: '/api',
    path: '/private',
    session,
    ...overrides
  };
}

// 直接调用认证中间件，并记录它是拒绝请求、放行请求，还是交出了错误。
function invokeMiddleware(req) {
  const res = makeResponse();
  let nextCalled = false;
  let nextError;

  return Promise.resolve(requireAuth(req, res, (error) => {
    nextCalled = true;
    nextError = error;
  })).then(() => ({ req, res, nextCalled, nextError }));
}

// 临时替换按 ID 查询用户的方法，避免连接真实数据库。
// 返回恢复函数，由每个测试结束时调用，防止影响其他测试。
function mockUserLookup(implementation) {
  const originalFindById = User.findById;
  User.findById = implementation;
  return () => { User.findById = originalFindById; };
}

// 没有会话时应返回 401，且不能继续执行后续路由。
test('拒绝未登录请求并返回 401', async () => {
  const { res, nextCalled } = await invokeMiddleware(makeRequest(undefined));

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 401);
  assert.equal(nextCalled, false);
});

// 仅设置 isLogin 但没有 userid 也不是有效登录态。
test('拒绝缺少用户 ID 的伪造登录态', async () => {
  const { res, nextCalled } = await invokeMiddleware(makeRequest({ isLogin: true }));

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

// 用户存在且状态正常时，中间件应放行，并将数据库中的身份信息写入 req.authUser。
test('有效登录态允许访问，并将数据库用户绑定到请求', async (t) => {
  // mongoose 的 findById(...).select(...) 是链式调用，这里模拟 select 查询结果。
  t.after(mockUserLookup(() => ({
    select: async () => ({ _id: 'user-a', username: 'alice', role: 'user', status: 'active' })
  })));

  const { req, res, nextCalled, nextError } = await invokeMiddleware(
    makeRequest({ isLogin: true, userid: 'user-a' })
  );

  assert.equal(nextCalled, true);
  assert.equal(nextError, undefined);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(req.authUser, {
    id: 'user-a', username: 'alice', role: 'user', status: 'active'
  });
});

// 注销会清除登录会话；之后请求不再携带有效登录信息，应被拒绝。
test('注销后原会话不能继续访问受保护接口', async () => {
  const { res, nextCalled } = await invokeMiddleware(makeRequest({}));

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

// 即使会话仍标记为已登录，也要以数据库里的账号状态为准。
// 禁用账号会收到 401，同时销毁会话并清除 sid Cookie。
test('账号已禁用时拒绝请求、销毁会话并清除 sid cookie', async (t) => {
  let sessionDestroyed = false;
  t.after(mockUserLookup(() => ({
    select: async () => ({ _id: 'user-a', username: 'alice', role: 'user', status: 'disabled' })
  })));

  const { res, nextCalled } = await invokeMiddleware(makeRequest({
    isLogin: true,
    userid: 'user-a',
    destroy(callback) {
      sessionDestroyed = true;
      callback();
    }
  }));

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.message, '账号当前不可用');
  assert.equal(sessionDestroyed, true);
  assert.deepEqual(res.clearedCookies, ['sid']);
  assert.equal(nextCalled, false);
});

// 用户被删除后，旧会话不能继续访问受保护接口。
test('已删除用户的会话失效', async (t) => {
  let sessionDestroyed = false;
  t.after(mockUserLookup(() => ({ select: async () => null })));

  const { res, nextCalled } = await invokeMiddleware(makeRequest({
    isLogin: true,
    userid: 'deleted-user',
    destroy(callback) {
      sessionDestroyed = true;
      callback();
    }
  }));

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.message, '用户不存在');
  assert.equal(sessionDestroyed, true);
  assert.equal(nextCalled, false);
});

// 数据库异常不应被误判成未登录；应交给 Express 的错误处理中间件处理。
test('数据库查询错误交给 Express 错误处理中间件', async (t) => {
  const failure = new Error('database unavailable');
  t.after(mockUserLookup(() => ({ select: async () => { throw failure; } })));

  const { res, nextCalled, nextError } = await invokeMiddleware(
    makeRequest({ isLogin: true, userid: 'user-a' })
  );

  assert.equal(nextCalled, true);
  assert.equal(nextError, failure);
  assert.equal(res.body, undefined);
});

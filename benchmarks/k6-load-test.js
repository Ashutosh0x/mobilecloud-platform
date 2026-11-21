// k6 high-concurrency ingress load test (end-to-end testing doc section 5.1).
//
// Fires 2,500 concurrent virtual users through the tunnel into the phone's
// reverse proxy. Pass criteria: p95 < 35 ms, error rate < 0.1%.
//
// Usage: k6 run benchmarks/k6-load-test.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 200 },   // Warm-up to 200 RPS
    { duration: '3m', target: 1200 },  // Ramp to 1,200 RPS
    { duration: '5m', target: 2500 },  // Peak burst at 2,500 RPS
    { duration: '2m', target: 0 },     // Ramp-down
  ],
  thresholds: {
    http_req_duration: ['p(95)<35'],   // 95% of requests under 35ms
    http_req_failed: ['rate<0.001'],   // Error rate < 0.1%
  },
};

// Override with -e TARGET=https://store.myphone.live
const TARGET = __ENV.TARGET || 'https://store.myphone.live';

export default function () {
  const res = http.get(`${TARGET}/api/products`);
  check(res, {
    'status is 200': (r) => r.status === 200,
    'body size verified': (r) => r.body.length > 500,
  });
  sleep(0.05);
}

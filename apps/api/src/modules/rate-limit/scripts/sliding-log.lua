local key       = KEYS[1]
local limit     = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now_ms     = tonumber(ARGV[3])

local min_ms = now_ms - window_ms

-- Cleanup old entries
redis.call('ZREMRANGEBYSCORE', key, 0, min_ms)

-- Count entries
local count = redis.call('ZCARD', key)

if count >= limit then
  -- Find earliest timestamp to calculate reset
  local earliest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset_in = 0
  if #earliest > 0 then
    reset_in = math.ceil((tonumber(earliest[2]) + window_ms - now_ms) / 1000)
  end
  return { 0, 0, reset_in }
end

-- Add new entry
redis.call('ZADD', key, now_ms, now_ms)
redis.call('PEXPIRE', key, window_ms)

local remaining = limit - count - 1
return { 1, remaining, 0 }

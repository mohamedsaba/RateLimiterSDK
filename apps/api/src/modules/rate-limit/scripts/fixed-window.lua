local key       = KEYS[1]
local limit     = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])

local count = tonumber(redis.call('GET', key) or 0)

if count >= limit then
  -- Return blocked, remaining 0, reset unknown (could be TTL)
  local ttl = redis.call('PTTL', key)
  return { 0, 0, math.ceil(ttl / 1000) }
end

local new_count = redis.call('INCR', key)
if new_count == 1 then
  redis.call('PEXPIRE', key, window_ms)
end

local ttl = redis.call('PTTL', key)
return { 1, limit - new_count, math.ceil(ttl / 1000) }

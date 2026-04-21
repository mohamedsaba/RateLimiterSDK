local curr_key    = KEYS[1]
local prev_key    = KEYS[2]
local limit       = tonumber(ARGV[1])
local window_ms   = tonumber(ARGV[2])
local now_ms      = tonumber(ARGV[3])

local window_start = math.floor(now_ms / window_ms) * window_ms
local elapsed      = now_ms - window_start
local weight       = 1 - (elapsed / window_ms)

local prev_count = tonumber(redis.call('GET', prev_key) or 0)
local curr_count = tonumber(redis.call('GET', curr_key) or 0)
local rate       = prev_count * weight + curr_count

if rate >= limit then
  local reset_in = math.ceil((window_ms - elapsed) / 1000)
  return { 0, 0, reset_in }
end

local new_count = redis.call('INCR', curr_key)
redis.call('EXPIRE', curr_key, math.ceil(window_ms / 1000) * 2)

local remaining = limit - (prev_count * weight + new_count)
local reset_in  = math.ceil((window_ms - elapsed) / 1000)
return { 1, math.floor(remaining), reset_in }

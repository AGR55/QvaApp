import sqlite3,json,time,re,statistics,datetime
from zoneinfo import ZoneInfo
c=sqlite3.connect('file:/opt/qvaapply/data/qvaapply.sqlite?mode=ro',uri=True);c.row_factory=sqlite3.Row
now=int(time.time()*1000);since=now-4*86400000
out={'now':now}
def q(name,sql,args=()):
 try:out[name]=[dict(r) for r in c.execute(sql,args)]
 except Exception as e:out[name]={'error':str(e)}
q('insightsSchema','SELECT max(version) AS version FROM schema_migrations')
q('insightsHealth',"SELECT value FROM settings WHERE key='operational_health'")
q('insightsHistory','SELECT coin,count(*) AS records FROM fiat_balance_history GROUP BY coin')
q('cancellations',"select created_at,action,offer_uuid,detail from audit_log where created_at>? and (action like '%cancel%' or action like '%liquidity%' or action like '%restore%') order by id desc limit 100",(since,))
q('monetary_cancels',"select created_at,kind,state,operation_uuid,json_extract(request_json,'$.liquidityPreparation') as preparation,error from mutation_intents where created_at>? and kind='cancel_offer' order by created_at desc limit 50",(since,))
q('rejections',"select created_at,action,offer_uuid,detail from audit_log where created_at>? and action in ('automatic_apply_not_sent','qvapay_apply_rejected','market_feed_processing_error','market_fast_lane_warnings') order by id desc limit 70",(since,))
q('decisionCounts',"select date(created_at/1000,'unixepoch','-4 hours') as day,coin,decision,count(*) as count from decision_events where created_at>? group by day,coin,decision order by day,coin,decision",(since,))
q('recentDecisions',"select created_at,coin,decision,reason from decision_events where created_at>? and decision<>'ignored' order by id desc limit 25",(since,))
q('marketSettings',"select key,value from settings where key in ('market_source_mode','market_feed_last_decision_ms','market_feed_last_received_at','market_feed_last_processed_at','market_feed_last_outcome','market_feed_last_error','qva_apply_last_queue_ms','paused','refresh_enabled')",())
q('feedCounts',"select date(received_at/1000,'unixepoch','-4 hours') as day,json_extract(payload_json,'$.data.coin') as coin,event,state,count(*) as count from market_feed_events where received_at>? group by day,coin,event,state order by day,coin,event,state",(since,))
rows=c.execute("select created_at,detail from audit_log where created_at>? and action='offer_apply_timing' order by id desc limit 200",(since,)).fetchall()
groups={}
for r in rows:
 try:
  p=json.loads(r['detail']);day=datetime.datetime.fromtimestamp(r['created_at']/1000,ZoneInfo('America/Havana')).strftime('%Y-%m-%d')
  key=day+':'+str(p.get('outcome'));groups.setdefault(key,[]).append(p)
 except:pass
out['timings']={k:{'n':len(v),'example':v[0]} for k,v in groups.items()}
q('recentFeed',"select created_at,offer_uuid,detail from audit_log where action='market_feed_processed' order by id desc limit 20")
q('backgroundErrors',"select created_at,action,detail from audit_log where created_at>? and action like '%background_error' order by id desc limit 25",(since,))
def summary(values):
 values=sorted(values)
 if not values:return None
 return {'n':len(values),'p50':round(statistics.median(values),2),'p95':round(values[min(len(values)-1,int(len(values)*.95))],2),'max':round(values[-1],2)}
out['timings']={k:{'n':len(v),'queueMs':summary([x['dispatchedAt']-x['queuedAt'] for x in v if x.get('dispatchedAt') is not None]),
 'remoteMs':summary([x['finishedAt']-x['dispatchedAt'] for x in v if x.get('dispatchedAt') is not None])} for k,v in groups.items()}
q('huntingFlags','select hunt_buy_running,hunt_sell_running from bot_config where id=1')
q('markets','select code,active,hunt_buy_enabled,hunt_sell_enabled,buy_max_rate,sell_min_rate,fiat_balance,outgoing_transfer_fee from market_config')
reasons={}
for row in c.execute("select created_at,detail from audit_log where created_at>? and action='market_feed_processed'",(now-2*86400000,)):
 match=re.search(r'\(([^)]+)\) procesado desde el feed: (.*)\.$',row['detail'])
 if not match:continue
 coin,reason=match.groups()
 if coin not in ['BANK_CUP','CLASICA','ETECSA']:continue
 day=datetime.datetime.fromtimestamp(row['created_at']/1000,ZoneInfo('America/Havana')).strftime('%Y-%m-%d')
 reason=re.sub(r'[0-9a-f]{8}-[0-9a-f-]{27,}', '<id>',reason)
 reason=re.sub(r'\d+(?:\.\d+)?','#',reason)
 key=day+'|'+coin+'|'+reason;reasons[key]=reasons.get(key,0)+1
out['outcomes']=reasons
latencies={}
for row in c.execute("select event,received_at,processed_at,json_extract(payload_json,'$.data.coin') as coin,json_extract(payload_json,'$.sent_at') as sent from market_feed_events where received_at>? and event in ('p2p.created','p2p.reopened','p2p.range_created','p2p.range_updated')",(now-2*86400000,)):
 if row['coin'] not in ['BANK_CUP','CLASICA','ETECSA']:continue
 day=datetime.datetime.fromtimestamp(row['received_at']/1000,ZoneInfo('America/Havana')).strftime('%Y-%m-%d')
 key=day+'|'+row['coin'];value=latencies.setdefault(key,{'delivery':[],'processing':[]})
 try:
  sent=datetime.datetime.fromisoformat(row['sent'].replace('Z','+00:00')).timestamp()*1000
  value['delivery'].append(max(0,row['received_at']-sent))
 except (ValueError,TypeError,AttributeError):pass
 if row['processed_at']:value['processing'].append(max(0,row['processed_at']-row['received_at']))
out['feedLatency']={k:{metric:summary(values) for metric,values in v.items()} for k,v in latencies.items()}
# All commands below are read-only. Never collect environment variables, process
# arguments, private keys, request bodies, or deployment secret files.
import subprocess,shutil,os

def command(args, timeout=20):
 try:
  result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout)
  return {'status':result.returncode,'stdout':result.stdout[:40000],'stderr':result.stderr[:3000]}
 except Exception as error:return {'error':str(error)}

out['inventory']={name:command(args) for name,args in {
 'os':['cat','/etc/os-release'],
 'uptime':['uptime'],
 'memory':['free','-m'],
 'containers':['docker','ps','--format','{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}'],
 'stats':['docker','stats','--no-stream','--format','{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'],
 'packages':['dpkg-query','-W','-f=${binary:Package} ${Version} ${db:Status-Status}\n','php*','nodejs*','nginx*','openssh-server'],
 'services':['systemctl','list-units','--type=service','--state=running','--no-pager','--no-legend'],
 'timers':['systemctl','list-timers','--all','--no-pager'],
 'listeners':['ss','-lntup'],
 'connections':['ss','-tnp'],
 'processes':['ps','-eo','pid,ppid,user,comm,%cpu,%mem','--sort=-%cpu'],
 'sshBans':['fail2ban-client','status','sshd'],
 'firewall':['ufw','status','verbose'],
 'kernel':['uname','-sr'],
 'release':['readlink','/opt/qvaapply/current'],
 'nginx':['nginx','-v'],
 'dockerInfo':['docker','info','--format','{{.ServerVersion}}|liveRestore={{.LiveRestoreEnabled}}'],
 'updatePlan':['apt-get','-s','install','--only-upgrade','docker-ce','docker-ce-cli','containerd.io','docker-compose-plugin','docker-buildx-plugin','docker-ce-rootless-extras'],
 'pendingUpdates':['apt','list','--upgradable'],
}.items()}
names=command(['docker','ps','--format','{{.Names}}']).get('stdout','').splitlines()
out['runtimes']={}
for name in names:
 if re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}',name):
  out['runtimes'][name]=command(['docker','exec',name,'sh','-c',
   'for bin in node nodejs php php-fpm php-fpm8.3 php-fpm8.4 php-fpm8.5; do if command -v "$bin" >/dev/null 2>&1; then "$bin" --version; fi; done'])
  out['runtimes'][name]['processes']=command(['docker','top',name,'-eo','pid,user,comm'])
out['hostRuntimes']={name:command([name,'--version']) for name in ['node','nodejs','php','php-fpm'] if shutil.which(name)}
out['suspiciousExecutables']=[]
for pid in os.listdir('/proc'):
 if not pid.isdigit():continue
 try:
  path=os.readlink('/proc/'+pid+'/exe')
  if path.endswith(' (deleted)') or path.startswith(('/tmp/','/var/tmp/','/dev/shm/')):
   out['suspiciousExecutables'].append({'pid':pid,'exe':path})
 except OSError:pass
out['persistenceMetadata']=[]
for directory in ['/etc/cron.d','/etc/systemd/system','/root/.config/systemd/user']:
 if not os.path.isdir(directory):continue
 for name in sorted(os.listdir(directory)):
  path=os.path.join(directory,name)
  try:
   st=os.lstat(path);out['persistenceMetadata'].append({'path':path,'uid':st.st_uid,'mode':oct(st.st_mode & 0o7777),'mtime':st.st_mtime})
  except OSError:pass
print(json.dumps(out,ensure_ascii=False))

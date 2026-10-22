"""Explicitly dispatched, bounded Docker security maintenance for Ubuntu 26.04."""
import datetime,json,os,pathlib,sqlite3,subprocess,time

PACKAGES=[
 'docker-ce=5:29.9.2-1~ubuntu.26.04~resolute',
 'docker-ce-cli=5:29.9.2-1~ubuntu.26.04~resolute',
 'containerd.io=2.4.2-3~ubuntu.26.04~resolute',
 'docker-compose-plugin=5.6.1-1~ubuntu.26.04~resolute',
 'docker-buildx-plugin=0.38.1-1~ubuntu.26.04~resolute',
 'docker-ce-rootless-extras=5:29.9.2-1~ubuntu.26.04~resolute',
]
report={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'steps':[]}
prior=[]
os.umask(0o077)
env={**os.environ,'DEBIAN_FRONTEND':'noninteractive','NEEDRESTART_MODE':'l'}
def run(args,timeout=120,check=True):
 p=subprocess.run(args,text=True,capture_output=True,timeout=timeout,env=env)
 if check and p.returncode:raise RuntimeError('Command failed: '+args[0]+' '+(p.stdout+p.stderr)[-2500:])
 return p

def states():
 ids=run(['docker','ps','-aq']).stdout.split()
 if not ids:return []
 items=json.loads(run(['docker','inspect',*ids]).stdout)
 return [{'name':x['Name'].lstrip('/'),'id':x['Id'],'image':x['Config']['Image'],
          'running':x['State']['Running'],'health':x['State'].get('Health',{}).get('Status')} for x in items]

try:
 if os.geteuid()!=0:raise RuntimeError('Requires root')
 if 'VERSION_ID="26.04"' not in pathlib.Path('/etc/os-release').read_text():raise RuntimeError('Unexpected distribution')
 prior=[x for x in states() if x['running']]
 if not any(x['name']=='qvaapply' for x in prior):raise RuntimeError('QvaApply must be running before maintenance')
 if run(['docker','exec','qvaapply','node','--version']).stdout.strip()!='v24.22.1':raise RuntimeError('Apply the Node security patch first')
 backup=pathlib.Path('/opt/qvaapply/backups')/('docker-security-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
 backup.mkdir(mode=0o700,parents=True,exist_ok=False)
 (backup/'containers.private.json').write_text(run(['docker','inspect',*[x['id'] for x in prior]]).stdout)
 (backup/'package-versions.txt').write_text(run(['dpkg-query','-W',*[p.split('=')[0] for p in PACKAGES]]).stdout)
 import shutil
 if pathlib.Path('/etc/docker').exists():shutil.copytree('/etc/docker',backup/'docker-config',symlinks=True)
 source=sqlite3.connect('file:/opt/qvaapply/data/qvaapply.sqlite?mode=ro',uri=True)
 target=sqlite3.connect(str(backup/'qvaapply-before-maintenance.sqlite'))
 source.backup(target);target.close();source.close()
 report['backup']=str(backup);report['before']=prior
 run(['apt-get','update'],timeout=180)
 plan=run(['apt-get','-s','install','--only-upgrade',*PACKAGES]).stdout
 if any(line.startswith('Remv ') for line in plan.splitlines()):raise RuntimeError('Package removal was proposed; refusing')
 allowed={p.split('=')[0] for p in PACKAGES}
 if any(line.split()[1] not in allowed for line in plan.splitlines() if line.startswith('Inst ')):raise RuntimeError('Additional package upgrade proposed; refusing')
 report['packagePlan']=plan
 result=run(['apt-get','-o','DPkg::Lock::Timeout=120','-o','Dpkg::Options::=--force-confold','install','-y','--no-remove','--only-upgrade',*PACKAGES],timeout=420)
 report['steps'].append({'step':'packageUpgrade','status':result.returncode,'output':result.stdout[-5000:]})
 run(['systemctl','start','containerd','docker'])
 running={x['id'] for x in states() if x['running']}
 missing=[x['id'] for x in prior if x['id'] not in running]
 if missing:run(['docker','start',*missing])
 until=time.monotonic()+100
 while True:
  current={x['id']:x for x in states()}
  bad=[x['name'] for x in prior if not current.get(x['id'],{}).get('running') or current[x['id']]['health'] not in (None,'healthy')]
  if not bad or time.monotonic()>=until:break
  time.sleep(5)
 report['after']=[current[x['id']] for x in prior if x['id'] in current]
 report['versions']=run(['dpkg-query','-W',*[p.split('=')[0] for p in PACKAGES]]).stdout
 installed=dict(line.split() for line in report['versions'].splitlines())
 if any(installed.get(p.split('=')[0])!=p.split('=',1)[1] for p in PACKAGES):raise RuntimeError('Package versions do not match approved targets')
 report['nodeVersion']=run(['docker','exec','qvaapply','node','--version']).stdout.strip()
 if bad:raise RuntimeError('Containers not healthy: '+','.join(bad))
 if report['nodeVersion']!='v24.22.1':raise RuntimeError('Unexpected Node version after maintenance')
 report['success']=True
except Exception as error:
 report['success']=False;report['error']=str(error)
 # Preserve volumes and financial state. Restore running services/containers,
 # never roll back a financial database or recreate a container implicitly.
 if prior:
  try:
   run(['systemctl','start','containerd','docker'],check=False)
   running={x['id'] for x in states() if x['running']}
   missing=[x['id'] for x in prior if x['id'] not in running]
   if missing:run(['docker','start',*missing],check=False)
   report['recoveryStates']=states()
  except Exception as recovery:report['recoveryError']=str(recovery)
print(json.dumps(report))

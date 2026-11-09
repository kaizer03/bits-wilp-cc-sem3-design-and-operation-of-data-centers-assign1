from pathlib import Path
import json, math, statistics, csv
from datetime import datetime
from zoneinfo import ZoneInfo
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

LAB=Path(__file__).resolve().parents[1]
OUT=LAB.parent/'DODC Assignment Topics 7 and 10.docx'
ART=LAB/'report/figures'; ART.mkdir(parents=True,exist_ok=True)
SELECTION_PATH=ART.parent/'evidence-selection.json'
SELECTION=json.loads(SELECTION_PATH.read_text()) if SELECTION_PATH.exists() else {}
def latest(pattern,filename='checks.json'):
    key=pattern+'/'+filename
    if key in SELECTION:
        selected=LAB/SELECTION[key]
        return selected,json.loads(selected.read_text())
    paths=sorted((LAB/'evidence').glob(pattern+'/'+filename))
    if not paths: raise RuntimeError('Missing evidence '+pattern+'/'+filename)
    SELECTION[key]=str(paths[-1].relative_to(LAB))
    return paths[-1],json.loads(paths[-1].read_text())
PERF_PATH,PERF=latest('performance-*','summary.json')
ENV=json.loads((PERF_PATH.parent/'environment.json').read_text())
DEPLOY=json.loads((PERF_PATH.parent/'deployments.json').read_text())
RESOURCES=json.loads((PERF_PATH.parent/'resource-samples.json').read_text())
RUNS=json.loads((PERF_PATH.parent/'results.json').read_text())
assert PERF['groups']==144 and PERF['requests']==5760
assert all(x['summary']['errors']==0 for x in RUNS)
RP,REPLICATION=latest('replication-20*')
MP,MASTERS=latest('masters-20*')
MONP,MONITORING=latest('monitoring-20*')
AVP,AVAILABILITY=latest('availability-20*')
RECOVERY_PATH,RECOVERY=latest('recovery-20*')
UI_PATH,UI=latest('lifecycle-browser-*')
PDF_PATH,PDF=latest('preview-browser-*')
DASH_PATH,DASH=latest('monitoring-browser-*')
EVIDENCE=[('Catalogue',*latest('catalogue-20*')),('Lifecycle',*latest('lifecycle-20*')),('Access',*latest('access-20*')),('Availability',AVP,AVAILABILITY),('Recovery',RECOVERY_PATH,RECOVERY),('Replication',RP,REPLICATION),('Monitoring',MONP,MONITORING),('Three masters',MP,MASTERS)]
rows=PERF['summary']
def result(variant,operation,concurrency,size=1048576):
    return next(r for r in rows if r['variant']==variant and r['operation']==operation and r['concurrency']==concurrency and r['size']==size)
labels={'single':'One API','two':'Two APIs','single-wide':'One API wide','single-tight':'One API tight'}
variants=list(labels)
def plots():
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':12,'axes.spines.top':False,'axes.spines.right':False})
    fig,axes=plt.subplots(1,2,figsize=(10,4),layout='constrained')
    for ax,operation in zip(axes,['upload','download']):
        data=[result(v,operation,8) for v in variants]
        values=[d['medianRunP95Ms'] for d in data]
        ranges=[[min(d['runP95Ms']),max(d['runP95Ms'])] for d in data]
        ax.bar(range(4),values,color=['#4C78A8','#E28E2C','#54A484','#8A77B5'],width=.6)
        ax.errorbar(range(4),values,yerr=[[v-r[0] for v,r in zip(values,ranges)],[r[1]-v for v,r in zip(values,ranges)]],fmt='none',color='#222222',capsize=4)
        ax.set_xticks(range(4),['One\nAPI','Two\nAPIs','One\nwide','One\ntight']);ax.set_ylabel('Response p95 in milliseconds');ax.set_title(operation.title()+'  1 MiB  concurrency 8');ax.grid(axis='y',alpha=.2);ax.set_axisbelow(True)
    fig.savefig(ART/'performance.png',dpi=220);plt.close(fig)
    fig,ax=plt.subplots(figsize=(10,5.2));ax.set_xlim(0,10.3);ax.set_ylim(0,5.2);ax.axis('off')
    def box(x,y,w,h,text):
        ax.add_patch(FancyBboxPatch((x,y),w,h,boxstyle='round,pad=.04,rounding_size=.04',facecolor='#F3F5F7',edgecolor='#333333',linewidth=1));ax.text(x+w/2,y+h/2,text,ha='center',va='center',fontsize=12)
    def arrow(a,b,style='-'):
        ax.add_patch(FancyArrowPatch(a,b,arrowstyle='->',mutation_scale=12,color='#444444',linewidth=1,linestyle=style))
    box(.25,4.25,1.8,.7,'Browser');box(2.75,4.25,1.8,.7,'Nginx\n18380');box(5.5,4.1,4,.9,'API 1 and API 2\nShared catalogue and sessions')
    arrow((2.05,4.6),(2.75,4.6));arrow((4.55,4.6),(5.5,4.6))
    box(.25,2,2.9,1,'MongoDB catalogue\nSingle database member');box(3.8,2,2.4,1,'Storage master\nAssign and locate');box(7,2,1.25,1,'volume1\nCopy A');box(8.75,2,1.05,1,'volume2\nCopy B')
    arrow((6,4.1),(1.7,3));arrow((6.4,4.1),(5,3),'--');arrow((7.6,4.1),(7.6,3));arrow((8.25,2.5),(8.75,2.5))
    box(.25,.2,5.6,.75,'Prometheus 18381 and Grafana 18382\nUnpublished API metrics on port 9100');box(6.5,.2,3.3,.75,'One laptop and Docker VM\nNamed persistent volumes')
    ax.plot([9.5,10.1,10.1,3],[4.2,4.2,1.3,1.3],color='#444444',linestyle='--',linewidth=1);arrow((3,1.3),(3,.95),'--');ax.text(4.6,1.42,'Private metrics',fontsize=11)
    fig.savefig(ART/'architecture.png',dpi=220,bbox_inches='tight');plt.close(fig)
    fig,ax=plt.subplots(figsize=(10,3.8));ax.set_xlim(0,10);ax.set_ylim(0,3.8);ax.axis('off')
    steps=[('Validate role\nand revision',.1),('Assign ID and\nstore copies',2.6),('Commit metadata\ntransaction',5.1),('Return receipt\nHTTP 201',7.6)]
    for text,x in steps:
        ax.add_patch(FancyBboxPatch((x,2.3),2.1,.7,boxstyle='round,pad=.05',facecolor='#F3F5F7',edgecolor='#333333'));ax.text(x+1.05,2.65,text,ha='center',va='center',fontsize=10)
        if x<7:ax.add_patch(FancyArrowPatch((x+2.1,2.65),(x+2.5,2.65),arrowstyle='->',mutation_scale=12,color='#333333'))
    ax.text(5.9,1.45,'If the database acknowledgement is uncertain',ha='center',fontsize=10)
    ax.add_patch(FancyArrowPatch((6.1,2.3),(6.1,1.65),arrowstyle='->',mutation_scale=12,color='#333333'))
    ax.text(5.9,.9,'Retain stored bytes and return a recovery receipt\nRefresh metadata then verify and reconcile the receipt',ha='center',va='center',fontsize=10)
    fig.savefig(ART/'upload-flow.png',dpi=220,bbox_inches='tight');plt.close(fig)
plots()
D=Document();s=D.sections[0];s.page_width=Inches(8.5);s.page_height=Inches(11);s.top_margin=s.bottom_margin=Inches(.7);s.left_margin=s.right_margin=Inches(.8)
for name,size in [('Normal',11.5),('Title',23),('Heading 1',16),('Heading 2',12.5),('Caption',10)]:
    st=D.styles[name];st.font.name='Times New Roman';st.font.size=Pt(size);st.font.color.rgb=RGBColor(0,0,0)
    st.paragraph_format.space_after=Pt(7);st.paragraph_format.line_spacing=1.1
    rf=st.element.get_or_add_rPr().find(qn('w:rFonts'))
    if rf is None:rf=OxmlElement('w:rFonts');st.element.get_or_add_rPr().insert(0,rf)
    for a in list(rf.attrib):
        if a.endswith('Theme'):del rf.attrib[a]
    for a in ['ascii','hAnsi','eastAsia','cs']:rf.set(qn('w:'+a),'Times New Roman')
    for border in st.element.findall('.//'+qn('w:pBdr')):border.getparent().remove(border)
D.core_properties.title='Software Defined Infrastructure and Replicated Document Management';D.core_properties.author='';D.core_properties.subject='CC ZG508 Topics 7 and 10'
footer=s.footer.paragraphs[0];footer.alignment=WD_ALIGN_PARAGRAPH.CENTER
field=OxmlElement('w:fldSimple');field.set(qn('w:instr'),'PAGE');footer._p.append(field)
def p(text='',style=None):return D.add_paragraph(text,style)
def h(text):return D.add_heading(text,2)
def page(title):
    heading=D.add_heading(title,1);heading.paragraph_format.page_break_before=True
    return heading

def table(headers,rows,widths):
    t=D.add_table(rows=1,cols=len(headers));t.alignment=WD_TABLE_ALIGNMENT.CENTER;t.autofit=False
    for c,w in zip(t.columns,widths):c.width=Inches(w)
    for cells,row in [(t.rows[0].cells,headers)]+[(t.add_row().cells,row) for row in rows]:
        for cell,txt in zip(cells,row):cell.text=str(txt)
    for i,row in enumerate(t.rows):
        row._tr.get_or_add_trPr().append(OxmlElement('w:cantSplit'))
        if i==0:row._tr.get_or_add_trPr().append(OxmlElement('w:tblHeader'))
        for j,c in enumerate(row.cells):
            c.width=Inches(widths[j]);c.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER
            tc=c._tc.get_or_add_tcPr();b=OxmlElement('w:tcBorders')
            for edge in ['top','left','bottom','right','insideH','insideV']:
                el=OxmlElement('w:'+edge);el.set(qn('w:val'),'single');el.set(qn('w:sz'),'4');el.set(qn('w:color'),'D9D9D9');b.append(el)
            tc.append(b);sh=OxmlElement('w:shd');sh.set(qn('w:fill'),'E2EAF2' if i==0 else 'FFFFFF');tc.append(sh)
            margins=OxmlElement('w:tcMar')
            for edge in ['top','bottom','left','right']:
                el=OxmlElement('w:'+edge);el.set(qn('w:w'),'90');el.set(qn('w:type'),'dxa');margins.append(el)
            tc.append(margins)
            for para in c.paragraphs:
                para.paragraph_format.space_after=Pt(3);para.paragraph_format.line_spacing=1.05
                for r in para.runs:r.font.size=Pt(10.5);r.bold=i==0
    p();return t

def picture(file,caption,width=6.5):
    para=p();para.alignment=WD_ALIGN_PARAGRAPH.CENTER;para.paragraph_format.keep_with_next=True
    shape=para.add_run().add_picture(str(file),width=Inches(width));shape._inline.docPr.set('descr',caption)
    p(caption,'Caption')

def code(text):
    for line in text.split('\n'):
        para=p();para.paragraph_format.space_after=Pt(1);para.paragraph_format.line_spacing=1
        run=para.add_run(line);run.font.name='Courier New';run.font.size=Pt(9)
    p()

def equation(parts):
    para=p();para.alignment=WD_ALIGN_PARAGRAPH.CENTER;mathnode=OxmlElement('m:oMath')
    for text in parts:
        r=OxmlElement('m:r');t=OxmlElement('m:t');t.text=text;r.append(t);mathnode.append(r)
    para._p.append(mathnode)

def link(label,url):
    para=p(label+' ');el=OxmlElement('w:hyperlink');el.set(qn('r:id'),para.part.relate_to(url,'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',is_external=True))
    r=OxmlElement('w:r');pr=OxmlElement('w:rPr');color=OxmlElement('w:color');color.set(qn('w:val'),'245A81');pr.append(color);r.append(pr);t=OxmlElement('w:t');t.text=url;r.append(t);el.append(r);para._p.append(el)
# CONTENT BELOW
p('BITS Pilani\nWork Integrated Learning Programmes Division').alignment=WD_ALIGN_PARAGRAPH.CENTER
p('Design and Operation of Data Centers\nCC ZG508').alignment=WD_ALIGN_PARAGRAPH.CENTER
p();title=p('Software Defined Infrastructure and Replicated Document Management','Title');title.alignment=WD_ALIGN_PARAGRAPH.CENTER
p('Laboratory experiment covering Topics 7 and 10').alignment=WD_ALIGN_PARAGRAPH.CENTER
p();p('Student name  __________________________________');p('BITS ID  ________________________________________')
p('Experiment date  9 October 2026');p('Upload deadline  10 November 2026')
h('Abstract')
p('I used a small document library to study how a service behaves when its application processes, catalogue and file storage can fail separately. Two Express instances sit behind Nginx and share a MongoDB catalogue and session store. SeaweedFS holds the file bytes. Docker Compose specifies the networks, volumes and resource limits, so the same workload can run against different configurations.')
p('Stopping one storage service left existing two-copy files readable, but fresh uploads could not satisfy the requested policy. The restore drill recovered 174 versions and verified every restored hash. The benchmark completed 5,760 measured requests without errors. At 1 MiB and concurrency eight, a single full-core API had lower p95 latency than two half-core APIs. These were short runs on one laptop; I use them to compare configurations, not to size a production service.')

page('Workload and scope')
p('A small office needs one place to keep invoices, contracts and internal documents. People should be able to find an older version or restore a document moved to trash. Keeping the index in a browser would give each user a different list. Keeping file bytes inside an API container would make replacement risky. I kept both kinds of data outside the API processes.')
table(['Topic','Question investigated'],[('7  Software Defined Data Infrastructure design and deployment considerations','How can configuration define compute resources, networking, persistence, access and operations while allowing application replacement?'),('10  Software Defined Storage platforms used in modern enterprise clouds','How do programmable storage policies affect content placement, failure behaviour, expansion and recovery?')],[2.7,4.2])
p('Topic 7 covers deployment, resource allocation and service recovery. Topic 10 covers replica placement and how that placement affects reads and writes during a fault. The same library provides the workload for both parts [1].')
h('Functional requirements')
p('Editors can upload, categorise, revise, trash and restore documents. Viewers can browse history, preview or download a file, and export receipts. Everyone sees the same catalogue. Text, images and PDFs are previewed after a byte-count and SHA-256 check. A batch accepts up to ten nonempty files of at most 5 MiB each.')
h('Operational requirements')
p('The checks cover container replacement, loss of an API process, rejected writes from a viewer and restoration into a clean deployment. The recovery and failure tests run on separate projects with sample data.')

page('Deployment architecture')
picture(ART/'architecture.png','Figure 1  Main deployment with two APIs and separately managed metadata and content')
table(['Service','Purpose and persistence'],[('Nginx','Loopback application gateway and passive API failover; configuration mounted read-only.'),('api and api2','Express processes serving the bundled Bootstrap UI and document APIs; shared sessions and catalogue, no browser-local source of truth.'),('MongoDB 8.3.9','Metadata, receipts, activity and hashed sessions in a persistent named volume; one replica-set member.'),('SeaweedFS 4.48 master','Volume assignment and location lookup; separate persistent master data.'),('volume1 and volume2','Content copies under policy 001, each with its own named Docker volume.'),('Prometheus and Grafana','Optional local metrics collection and provisioned read-only operations dashboard.')],[1.75,5.15])
p('Nginx can reach both API instances on the front network. The APIs also join separate networks for MongoDB, storage and metrics. MongoDB, SeaweedFS and the API metrics listeners have no published ports. Prometheus and Grafana have an additional network for their loopback interfaces.')
p('Named volumes keep data when a container is replaced [2]. Both replicas still sit on the same host disk, so a laptop or disk failure can take out both copies.')

page('Document versions and retrieval')
p('The catalogue supports search, sorting and filters for type, category and trash state. An open page refreshes every fifteen seconds. A second browser can see the same uploads without copying local state from the first browser.')
h('Identity and retained versions')
p('The document keeps the same ID throughout its life. Each version has its own SeaweedFS identifier, hash, size and upload time. A category or trash change advances the metadata revision without writing another copy of the file. Trash leaves existing versions in storage.')
p('A change includes the revision the editor last read. If another request has already advanced it, the API returns HTTP 409 and the interface reloads the current record. Both roles can still read files in trash.')
picture(UI_PATH.parent/'version-history.png','Figure 2  Retained versions in the October browser test',width=4.9)
h('Receipts and verified previews')
p('A receipt describes a file; it does not contain the file. Before importing a receipt, the API fetches the object and checks its size and hash. An invalid entry rolls back the import. The same verification runs before a preview; the bundled PDF.js viewer renders up to ten pages [10].')

page('Storage selection and alternatives')
p('I chose SeaweedFS because I could stop a volume server, inspect the actual copies and then see how the application responded. The API asks the master for a file ID and destination, then sends the bytes to a volume server. The master also supplies locations for reads. The lab uses these native endpoints without a filer or S3 gateway.')
table(['Option','Suitable use','Trade-off for this experiment'],[('API local directory','Very small single-process service','Simple, but couples the runtime and its files unless external persistence and shared access are designed.'),('MongoDB binary data or GridFS','A database-centred document service','Can store content and metadata in one platform; does not expose the selected independent volume/rack placement experiment.'),('SeaweedFS plus MongoDB','Separate file storage and searchable application metadata','Programmable copy placement and independent service experiments, with an application consistency boundary to manage.')],[1.65,2.15,3.1])
p('For the file sizes used here, MongoDB binary fields would also work. GridFS handles larger files by splitting them into chunks, but it cannot participate in a multi-document transaction [3]. I did not benchmark either MongoDB option against SeaweedFS; the choice was about being able to test placement separately.')
h('Metadata and content separation')
p('The separation keeps changes to the storage policy out of the catalogue model. It also creates a failure window: a file can reach SeaweedFS before the API knows whether its MongoDB record committed. The upload response and receipt recovery account for that case.')
p('SHA-256 detects changed bytes when the expected hash comes from a trusted record. If someone can replace both the backup and its manifest, a matching checksum says little. A separate trusted checksum or signature would address that risk.')

page('Configuration and resource limits')
p('Compose records how to start the services and what each one can use. Startup is asynchronous: a running container may still be waiting for the database or storage registration. The runners wait for readiness before starting a workload.')
code('node scripts/prepare-local.mjs\ndocker compose up -d --build\n# Optional local monitoring\ndocker compose -f compose.yaml -f monitoring/compose.yaml \\\n  --profile monitoring up -d --build')
p('The application listens on port 18380. Optional monitoring uses ports 18381 and 18382. The preparation script creates missing database credentials and leaves existing ones in place. An initialized MongoDB volume still needs the credentials it was set up with.')
table(['Main service','CPU allowance','Memory limit'],[('Each API','0.5 core','256 MiB'),('MongoDB','0.5 core','512 MiB'),('Each storage service','0.5 core','256 MiB'),('Nginx','0.25 core','128 MiB'),('Prometheus','0.5 core','256 MiB'),('Grafana','0.5 core','384 MiB')],[2.9,2,2])
p('The recorded Docker VM had 16 CPUs and about 15.60 GiB of memory, on aarch64 with kernel 7.0.14-linuxkit. The limits in the table cap service use; they do not reserve dedicated cores. The benchmark records the effective limits from Docker before the measurements.')
p('MongoDB runs as a one-member replica set so the catalogue can use transactions [4]. There is no database failover. A one-time initializer creates the users; each API receives a credential limited to read and write access to the lab database.')

page('Upload acknowledgement and recovery')
picture(ART/'upload-flow.png','Figure 3  File storage and catalogue commit during upload')
p('The API checks the editor role and expected revision before writing. Once SeaweedFS acknowledges the bytes, the API commits the receipt and document changes in MongoDB. HTTP 201 follows the catalogue acknowledgement.')
h('Failure between storage and metadata')
p('If the database connection drops during commit, the API cannot tell immediately whether the write took effect. Deleting the stored bytes could break a version that actually committed. The API keeps the bytes and returns a recovery receipt with the failure response. The interface can export that receipt and check the catalogue after the database comes back.')
p('Recovery verifies the stored bytes and can be retried without duplicating the document. If the failed write was a new version, recovery can register those bytes as a separate document. The original document history still needs to be checked before adding another version.')
h('Metadata transaction boundaries')
p('Metadata transactions cover publication, category and trash changes, and receipt imports. An invalid entry in an import rolls back earlier entries in that batch. The tests include revision conflicts, simultaneous imports and a batch of 105 receipts, which crosses the default initial cursor batch of 101.')
p('A backup reads a consistent metadata snapshot, then copies the bytes that snapshot refers to. Those bytes can be read later because versions are immutable and the application has no hard delete. A retention policy would need to keep referenced versions available while a backup is running.')

page('Access control and verification')
table(['Action','Viewer','Editor'],[('Catalogue history and retained trash','Allowed','Allowed'),('Verified preview and download','Allowed','Allowed'),('Export retrieval receipts','Allowed','Allowed'),('Upload or new content version','Denied','Allowed'),('Category change trash and restore','Denied','Allowed'),('Verified receipt import','Denied','Allowed')],[4.5,1.2,1.2])
p('Both API instances read sessions from MongoDB, so a sign-in continues to work if Nginx routes the next request to the other process. Passwords use salted scrypt. The database stores hashes of the session tokens, which expire after eight hours. Cookies use HttpOnly and SameSite Strict. Signing out revokes the session.')
p('The server checks permissions even if a browser bypasses the controls. Write requests also need the exact workspace Origin. A file ID alone cannot retrieve an uncatalogued object. After fifteen failed sign-ins for a username and gateway address in ten minutes, further attempts receive 429.')
h('Local boundaries')
p('The two demo accounts are for loopback HTTP. A remote deployment would need HTTPS and Secure cookies. There is one shared catalogue; the viewer and editor roles do not separate tenants or restrict access to individual documents. Browser security headers restrict scripts and framing.')
p('Size and hash checks cover imports, reads, previews and restored versions. The restore verifier also checks that the manifest and catalogue references agree and refuses symlink substitution. Recent activity is useful for troubleshooting; it is not a security audit log.')

page('Test setup and evidence')
p('Failure tests ran away from the main library. The recovery, replication, benchmark and master projects used separate named volumes. The runners stopped their test services afterwards and left their volumes available for inspection.')
table(['Experiment','Variable or intervention','Observation'],[('Shared catalogue and lifecycle','Two clients, invalid imports, stale/concurrent revisions, recreation','Shared visibility, atomicity, conflicts and retained versions.'),('Access','Anonymous/viewer/editor requests, origin, expiry, revocation','Server enforcement and shared session state.'),('API availability','Stop/recreate API, database, master or volumes','Liveness/readiness, actual reads/writes, errors and recovery.'),('Backup and restore','Snapshot, corruption, post-snapshot write, clean target','Retained metadata/content, rejected unsafe targets and time.'),('Replication and expansion','000, 001, 010; one owner down; add third service','Actual copy hashes, rack labels and allocation slots.'),('Monitoring','Traffic and sustained component failures','Metrics, local alert firing and resolution.'),('Performance','Resources, API count, payload size and concurrency','Repeated response distributions, throughput and resources.'),('Three masters','Leader loss and two unreachable peers','Leader observation, existing reads and fresh allocation.')],[1.55,2.45,2.9])
p('The evidence includes the checks, source fingerprints, runtime settings and raw samples. Two master runs are included because they gave different results for writes after majority loss. The browser screenshots are from the October runs.')
p('All workloads used sample data. The processes shared the laptop, Docker VM and disk. The fault tests stopped services and did not interrupt a physical rack, link or site. Request times are local to this setup.')

page('Application availability results')
p('Nginx resolves both API services through Docker DNS. It can try the peer after a connection error or timeout, within the configured retry budget. It does not replay a POST or PATCH that was already sent upstream. A 503 from a shared dependency passes through to the client [5].')
table(['Failure','Observed service behaviour','Interpretation'],[('One API stops','Peer serves verified reads and new uploads after bounded detection','Two application processes reduce this process failure risk.'),('API recreated','New address discovered without gateway restart','DNS resolution matters when replaceable services change address.'),('MongoDB unavailable','Health stays live; catalogue and uploads return 503','Shared metadata/session dependency defeats API-only redundancy.'),('Storage master unavailable','Readiness reports coordinator failure; catalogue remains','Metadata can survive while file lookup/assignment is unavailable.'),('One volume unavailable under 001','Surviving content can be read; requested write-copy count is degraded','Read and write availability have different requirements.'),('Both volumes unavailable','Readiness remains unready until recovery','A live API does not imply an available document service.')],[1.65,2.65,2.6])
p('The runner passed twelve groups. Among them were an API starting before MongoDB was available and a deliberately uncertain catalogue acknowledgement. The first checked that the API recovered without a restart. The second checked that Nginx did not resend the upload.')
p('Some probes returned 502 or 504 while Nginx detected the failure or resolved a new container address. Its health routing is passive; it does not poll /api/ready. Readiness checks the catalogue, coordinator and at least one storage service. It reports reachable copy count separately, since that count does not prove suitable placement or quorum.')
p('The second API covers an application process loss. Both APIs still depend on Nginx, one MongoDB member and the same laptop.')

page('Replica placement and expansion')
table(['Policy','Content copies','Logical placement','Payload copy bytes'],[('000','1','One service','262144'),('001','2','Two services in rack1','524288'),('010','2','Two logical racks','524288')],[1,1.2,3.1,1.6])
p('The test used a 256 KiB fixture and fetched each copy directly to verify its hash. Policy 001 kept the copies under one rack label; 010 used two labels [6]. The labels affect placement but do not give the containers separate power or network paths.')
equation(['Payload copy ratio = retained payload copy bytes / logical payload bytes'])
p('Two copies took 524,288 bytes of payload for a 262,144-byte file. The 2:1 ratio does not include preallocation, indexes or filesystem overhead.')
table(['Scenario','000','001 and 010'],[('Owning service stopped before expansion','Original read 503; fresh write 201 on surviving service','Original read 200; fresh write 503 with only one registered service.'),('Owning service restarted','Original hash matches','Original hash matches.'),('Third service added','Configured slots increase 16 to 24','Configured slots increase 16 to 24; original placement unchanged.'),('One service stopped after expansion','Not repeated for 000','New write 201 on two survivors; earlier content remains readable.')],[2.55,2,2.35])
p('All fourteen checks passed. Adding a third volume service raised configured slots from 16 to 24 and gave new writes another placement option. The existing pair stayed where it was. Neither a higher slot count nor a surviving replica removes the need for a separate backup.')

page('Backup and restore')
p('The backup takes a MongoDB snapshot of documents, version receipts and activity. It then fetches the immutable versions by authenticated reads. Files with the same hash are stored once. Before restore, the verifier checks sizes, hashes, references and the completion marker.')
p('The restore uses an empty project on a different port. SeaweedFS assigns new file IDs; the restore remaps the references and keeps the original document IDs, categories, revisions, trash state and version history. Old receipts still point at the old store. Users, sessions and unindexed objects are outside the backup.')
backup=next(c['snapshot'] for c in RECOVERY['checks'] if 'snapshot' in c)
recovery=next(c for c in RECOVERY['checks'] if 'provisionAndVerifiedRecoveryMilliseconds' in c)
table(['Recorded quantity','Result'],[('Documents / retained content versions',f"{backup['documents']} / {backup['retainedVersions']}"),('Logical bytes in snapshot',f"{backup['logicalBytes']:,}"),('Verified backup duration',f"{backup['elapsedMilliseconds']/1000:.3f} s"),('Clean deployment provisioning',f"{recovery['provisionMilliseconds']/1000:.3f} s"),('Restore with content verification',f"{recovery['restoreMilliseconds']/1000:.3f} s"),('Provisioning plus verified recovery',f"{recovery['provisionAndVerifiedRecoveryMilliseconds']/1000:.3f} s")],[4.6,2.3])
p('All nine checks passed and every restored version matched its hash. Bad checksums, a symlink and a second restore over the existing catalogue were rejected. A write made after the snapshot was absent after restore, as expected.')
p('The 15.532-second result includes starting the recovery deployment and verifying 6,733 bytes of sample data. I would not use it as a recovery-time target for a larger installation. The recoverable point was the snapshot timestamp; potential loss during a real incident depends on when the last good backup was taken. A copy on this laptop cannot cover loss of the laptop.')

page('Monitoring during faults')
p('Prometheus scrapes the private API listeners every ten seconds. The metrics cover request rates, durations, replica read failures, dependency readiness and process resources. Route labels use a fixed set of values, rather than identifiers or account data [7].')
p('Grafana loads eight panels from a provisioned dashboard. Prometheus alerts after a missing scrape target or failed dependency probe persists for twenty seconds. Anonymous access is read-only; an attempted dashboard write returned 403 [8].')
picture(DASH_PATH.parent/'grafana.png','Figure 4  Operations dashboard after the fault tests',width=3.85)
p('The monitoring checks passed in six groups. Stopping one API raised a scrape alert while the peer still served the catalogue. Stopping MongoDB raised dependency alerts while both metrics listeners stayed reachable. The alerts cleared after recovery and the original test file still matched its hash.')
p("The dashboard estimates p95 from histogram buckets. I used individual request timings for the benchmark instead. The dashboard also shows process memory, which is not the same as Docker's container memory reading.")

page('Benchmark method')
table(['Condition','API instances','Total API CPU','Total API memory'],[('One API','1','0.5 core','256 MiB'),('Two APIs','2','1.0 core','512 MiB'),('One API wide','1','1.0 core','512 MiB'),('One API tight','1','0.25 core','128 MiB')],[2.1,1.35,1.7,1.75])
p('I kept the gateway, MongoDB and storage limits fixed and ran four configurations in sequence. All used policy 001. The single-API runs did not start a second process. Docker inspection recorded image IDs and effective limits. The main library stayed idle with monitoring enabled.')
p('The workload used deterministic 4 KiB, 256 KiB and 1 MiB files, with one or eight concurrent requests and three repeats. Each size had eight warmup reads. A group measured sixteen uploads or sixty-four downloads. The 144 groups and 5,760 measured requests exclude fixture setup and warmups.')
p('Per-request timing ends when the full response body arrives. The batch clock also includes client-side verification. Each download was hashed. Upload checks compared the returned receipt with the expected size and hash; only the warmup fixtures were read back to verify stored bytes.')
equation(['Throughput = successful requests / measured batch seconds'])
p('The nearest-rank p95 is the value at position ceil(0.95 × n) in the sorted latencies. For sixteen uploads it is the slowest request. The tables report the median of three run p95 values and the median throughput. Three short runs show variation but do not give a confidence interval.')
p('Docker statistics were sampled during each project and can miss short peaks. The client ran Node 24.19.0 on macOS arm64; the Docker engine was 29.8.2 on aarch64. The workload does not represent sustained traffic or a real WAN.')

page('Benchmark results')
p('All 5,760 measured requests passed their status and integrity checks. Final inspection showed no restarts or OOM kills. The table shows the 1 MiB cases; the evidence includes the other sizes and individual timings.')
perfrows=[]
for v in variants:
    for c in [1,8]:
        u,d=result(v,'upload',c),result(v,'download',c)
        perfrows.append((labels[v],c,f"{u['medianRunP95Ms']:.1f}",f"{d['medianRunP95Ms']:.1f}",f"{u['medianRunThroughput']:.1f}",f"{d['medianRunThroughput']:.1f}"))
table(['Condition','N','Upload p95 ms','Read p95 ms','Uploads per s','Reads per s'],perfrows,[1.6,.65,1.15,1.1,1.2,1.2])
picture(ART/'performance.png','Figure 5  Median p95 for 1 MiB at concurrency eight, with the range across three runs',width=5.8)
u,d=result('single-wide','upload',8),result('single-wide','download',8)
p(f"At concurrency eight, one API wide produced median run p95 values of {u['medianRunP95Ms']:.1f} ms for upload and {d['medianRunP95Ms']:.1f} ms for download. It performed better than two APIs with the same aggregate allowance in this finite workload. Two APIs improved over the half-core baseline but also doubled its CPU and memory allowance. The result does not support a claim that another instance alone causes linear speedup.")
p('The quarter-core configuration also had the smallest memory limit, so these tests cannot isolate CPU from memory effects. The error bars show the spread across three runs. I would still keep the second API if process failover mattered more than the latency advantage of the wider single process.')

page('Resource use and sizing')
def memory_mib(text):
    part=text.split('/')[0].strip();units={'B':1/1048576,'KiB':1/1024,'MiB':1,'GiB':1024,'kB':1000/1048576,'MB':1000000/1048576,'GB':1000000000/1048576}
    import re
    m=re.match(r'([0-9.]+)\s*([A-Za-z]+)',part)
    return float(m.group(1))*units[m.group(2)] if m and m.group(2) in units else None
resourceRows=[];resourceSummary=[]
for v in variants:
    entries=[c for record in RESOURCES if record.get('variant')==v for c in record.get('containers',[]) if '-api-' in c.get('Name','') or '-api2-' in c.get('Name','')]
    for service in ['api','api2']:
        selected=[x for x in entries if '-'+service+'-' in x.get('Name','')]
        if not selected:continue
        cpu=max(float(x['CPUPerc'].rstrip('%')) for x in selected);mem=max(memory_mib(x['MemUsage']) or 0 for x in selected)
        resourceRows.append((labels[v],service,len(selected),f'{cpu:.1f}%',f'{mem:.1f} MiB'));resourceSummary.append({'variant':v,'service':service,'samples':len(selected),'maxObservedCPUPercent':cpu,'maxObservedMemoryMiB':mem})
table(['Condition','Process','Samples','Peak sampled CPU','Peak sampled memory'],resourceRows,[1.8,1,.9,1.6,1.6])
p('The table reports the highest samples, not guaranteed peaks. In Docker, roughly 100 percent CPU means one core, so a busy half-core container can show close to 50 percent. Container memory includes more than the process resident memory shown in Grafana.')
p('Every request shares the Docker VM and disk with the database and store. The timings include gateway handling, session checks and work such as hash verification and catalogue activity. They do not isolate any one bottleneck.')
h('Sizing decisions')
p('For this workload I would size one API process before assuming that more replicas improve latency. Adding the second API is a separate decision about process failure. The database and storage would need their own measurements before sizing a larger deployment.')
p('The jump from 16 to 24 slots describes a setting, not available disk space. Capacity planning needs the size of retained versions, replica copies, indexes and backup retention. Moving a document to trash does not free space in this library.')

page('SeaweedFS master failover')
p('The separate three-master configuration gives each peer its own volume and gives each storage service all three addresses. The API tries the configured coordinator endpoints with bounded waits and prefers the last one that worked. The main library remains on one master.')
p('Both runs stopped the elected leader and observed a replacement followed by a successful upload. Sampled reads of the original file kept working. In the later run, the first successful read was recorded about 0.192 seconds after the stop began. A successful read and the replacement leader were both observed at 14.730 seconds, including stop and polling time [9].')
table(['With two peers stopped','Earlier run','Later run'],[('Fresh collection assignment','406 with no writable volume','Six-second client timeout'),('Original application file read','200','200'),('Upload using existing placement','503','201'),('Direct stored content hash','Matched','Matched')],[3.1,1.9,1.9])
p('A new collection forces an allocation request. Neither bounded probe acknowledged an allocation with two peers stopped. Uploads to existing placement returned different statuses. That difference is why I would monitor fresh allocation separately from reads and existing-placement writes.')
p('The remaining master reported IsLeader while its peers were unreachable. That flag did not establish that a majority was available. Direct reads still returned the original hash. After the peers restarted, the runner confirmed the original file and a new upload.')
p('All three peers shared the laptop. This test covers a stopped service; it does not establish behaviour during real network partitions or a host failure.')

page('Limitations and deployment improvements')
p('The lab covers service isolation and storage policy on one host. It has no physical switch fabric, separate racks or sites. The Docker networks are ordinary bridges.')
table(['Limitation','Consequence','Next design step'],[('One laptop and Docker VM','Host/disk failure affects every logical copy','Place services and backups in independent physical failure domains.'),('One gateway and database member','Shared failures defeat two-API redundancy','Add a gateway strategy and independently hosted database quorum.'),('Main single storage master','Coordinator failure blocks lookup/assignment','Evaluate the tested multi-master arrangement in separate failure domains.'),('Local backup destination','Host loss can remove live data and backup','Secure off-device copies, retention and regular restore drills.'),('Public demo accounts and shared workspace','No individual accountability or tenant boundary','Integrate identity management and document-level authorization.'),('Immutable retention with no hard deletion','Deleted documents continue consuming bytes','Design retention, garbage collection and backup-aware deletion.'),('Finite sequential benchmark','Order, caches and background work can affect timing','Use longer randomized trials and instrument component-level latency.')],[1.6,2.35,2.95])
p('The API buffers files up to 5 MiB. To handle larger files or higher concurrency, I would add streaming and measure how it affects memory and request time. The prototype has no malware scanning, encryption-at-rest design or independent disaster recovery.')
p('For a larger rollout I would first set the recovery and latency targets, then place replicas and backups in independent failure domains. The laptop timings are a baseline for comparison, not a production SLA.')

page('Reproducing the lab')
h('Test workload')
p('The application checks use a sample invoice and its revised version. They cover upload, category changes, both version downloads, trash and restore, plus a rejected viewer write.')
p('The fault and recovery runners use separate Compose projects. They record status, file hashes and service state while an API, database or storage service is stopped and again after recovery.')
p('The replication, recovery and performance directories contain the data needed to compare the configurations without repeating a fault against the main library.')
h('Local commands')
code('node scripts/prepare-local.mjs\ndocker compose up -d --build\nnode scripts/backup-local.mjs backup \\\n  --project dodc-document-lab --port 18380 --out NEW_DIRECTORY\nnode scripts/backup-local.mjs verify --in BACKUP_DIRECTORY')
p('Run these commands from DocumentStorageLab. The README describes the demo accounts and how to restore into a separate empty project. Integration runners are in tests, with Compose overrides in experiments.')
p('Each installation generates its own local database credentials. The archive contains source, sample documents and recorded results; it does not contain the running database or its credentials.')

page('Evidence and findings')
table(['Experiment','Passed groups','Evidence directory'],[(name,len(data['checks']),str(file.parent.relative_to(LAB))) for name,file,data in EVIDENCE],[1.25,.8,4.85])
p('The October browser runs cover both roles, catalogue sharing, version history, trash, mobile layouts and verified previews. Deployment checks compare the served source files and read the three original samples through the shared catalogue.')
p('The performance directory contains the environment, deployment limits, resource samples and raw timings behind the tables. The master section draws on two runs because the existing-placement write returned different results.')
h('Conclusion')
p('The main storage result was that existing reads and fresh writes failed under different conditions. A surviving copy could serve an existing file even when another upload could not meet the placement policy. Adding a third service changed future placement without moving the files already stored.')
p('I would keep the verified backup separate from replica placement and monitor catalogue readiness and new allocation as distinct checks. For the 1 MiB benchmark, the wider single process was faster at the same total allowance; the two-process configuration still covered an API failure. Host loss and production capacity need tests on separate infrastructure.')

page('References')
p('[1] BITS Pilani WILP. Design and Operation of Data Centers assignment brief. Topics 7 and 10.')
refs=[('[2] Docker named volumes','https://docs.docker.com/engine/storage/volumes/'),('[3] MongoDB GridFS and its transaction limits','https://www.mongodb.com/docs/manual/core/gridfs/'),('[4] MongoDB transactions and snapshot read concern','https://www.mongodb.com/docs/manual/core/transactions/'),('[5] Nginx upstream handling and proxy retries','https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream'),('[6] SeaweedFS replication policy','https://github.com/seaweedfs/seaweedfs/wiki/Replication'),('[7] Prometheus Node client metrics','https://github.com/prometheus/client_js'),('[8] Grafana provisioning','https://grafana.com/docs/grafana/latest/administration/provisioning/'),('[9] SeaweedFS master failover','https://github.com/seaweedfs/seaweedfs/wiki/Failover-Master-Server'),('[10] Mozilla PDF.js rendering examples','https://mozilla.github.io/pdf.js/examples/'),('[11] Docker Compose override semantics','https://docs.docker.com/reference/compose-file/merge/'),('[12] Prometheus configuration','https://prometheus.io/docs/prometheus/latest/configuration/')]
for label,url in refs:link(label,url)
p('Software in the recorded runs: MongoDB 8.3.9, MongoDB Node driver 7.7.0, SeaweedFS 4.48, Prometheus 3.14.0, Grafana OSS 13.2.3 and Nginx 1.30.5.')
# Export compact analysis as well as the editable Word report.
with (PERF_PATH.parent/'summary.csv').open('w',newline='') as stream:
    fields=['variant','operation','size','concurrency','runs','errors','medianRunP95Ms','medianRunThroughput'];writer=csv.DictWriter(stream,fieldnames=fields,extrasaction='ignore');writer.writeheader();writer.writerows(rows)
(ART.parent/'resource-analysis.json').write_text(json.dumps(resourceSummary,indent=2)+'\n')
(ART.parent/'report-inputs.json').write_text(json.dumps({'performance':str(PERF_PATH.relative_to(LAB)),'replication':str(RP.relative_to(LAB)),'masters':str(MP.relative_to(LAB)),'monitoring':str(MONP.relative_to(LAB)),'recovery':str(RECOVERY_PATH.relative_to(LAB)),'lifecycleUI':str(UI_PATH.relative_to(LAB)),'dashboard':str(DASH_PATH.relative_to(LAB))},indent=2)+'\n')
SELECTION_PATH.write_text(json.dumps(SELECTION,indent=2)+'\n')
D.save(OUT);print(OUT)

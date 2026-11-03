use super::*;

const MAX_ITEMS: usize = 32;
const MAX_QUEUE: usize = MAX_ITEMS * (MAX_BUILD_SPEC * 6 + 4096);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Waiting,
    Started,
    Paused,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Item {
    parent_id: String,
    name: String,
    revision: String,
    status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Saved {
    item: Item,
    content: String,
    child_id: String,
}

// Queue IO and Stop intent are serialized with app.files. No network IO is
// performed under that mutex; admission also holds recovery_gate.
fn load(app: &App) -> Result<Vec<Saved>> {
    let data = match recovery::directory(app, false)
        .and_then(|dir| recovery::bytes(&dir, "queued-builds", MAX_QUEUE))
    {
        Ok(data) => data,
        Err(Error(StatusCode::NOT_FOUND, _)) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let items: Vec<Saved> =
        serde_json::from_slice(&data).map_err(|_| invalid("Invalid queued build storage"))?;
    if items.len() > MAX_ITEMS {
        return Err(invalid("Too many queued builds"));
    }
    let mut parents = std::collections::HashSet::new();
    for saved in &items {
        recovery::valid_id(&saved.item.parent_id)?;
        recovery::valid_id(&saved.child_id)?;
        validate(&saved.item.name)?;
        if !parents.insert(&saved.item.parent_id)
            || saved.content.trim().is_empty()
            || saved.content.len() > MAX_BUILD_SPEC
            || saved.item.revision != format!("{:x}", Sha256::digest(saved.content.as_bytes()))
            || saved
                .item
                .id
                .as_ref()
                .is_some_and(|id| id != &saved.child_id)
        {
            return Err(invalid("Invalid queued build snapshot"));
        }
    }
    Ok(items)
}

fn persist(app: &App, items: &[Saved]) -> Result<()> {
    let data = serde_json::to_vec(items).map_err(|_| invalid("Cannot encode queued builds"))?;
    if data.len() > MAX_QUEUE {
        return Err(invalid("Queued build storage exceeds size limit"));
    }
    recovery::atomic(&recovery::directory(app, true)?, "queued-builds", &data)
}

fn stopped(app: &App, id: &str) -> Result<bool> {
    recovery::valid_id(id)?;
    match recovery::directory(app, false)
        .and_then(|dir| recovery::bytes(&dir, &format!("stop-{id}"), 1))
    {
        Ok(_) => Ok(true),
        Err(Error(StatusCode::NOT_FOUND, _)) => Ok(false),
        Err(error) => Err(error),
    }
}

fn view(app: &App, saved: &Saved) -> Result<Item> {
    let mut item = saved.item.clone();
    if matches!(item.status, Status::Started) {
        match recovery::load(app, &saved.child_id) {
            Ok(_) => {}
            Err(Error(StatusCode::NOT_FOUND, _)) => {
                item.status = Status::Paused;
                item.reason = Some(
                    "Dispatch interrupted before child registration; automatic retry disabled"
                        .into(),
                );
            }
            Err(error) => return Err(error),
        }
    } else if matches!(item.status, Status::Waiting) && stopped(app, &item.parent_id)? {
        item.status = Status::Paused;
        item.reason = Some("Parent was stopped".into());
    }
    Ok(item)
}

pub(super) async fn list(State(app): State<App>) -> Result<Json<Vec<Item>>> {
    let _files = app.files.lock().unwrap();
    load(&app)?
        .iter()
        .map(|saved| view(&app, saved))
        .collect::<Result<Vec<_>>>()
        .map(Json)
}

pub(super) async fn enqueue(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(input): Json<Run>,
) -> Result<Json<Item>> {
    recovery::valid_id(&id)?;
    validate(&input.name)?;
    if input.revision.len() != 64 || !input.revision.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid("Invalid saved revision"));
    }
    recovery::initialize(&app)?;
    let _run = recovery::run_gate(&app, &id).await;
    let _admission = app.recovery_gate.lock().await;
    let _files = app.files.lock().unwrap();
    let mut items = load(&app)?;
    if let Some(saved) = items.iter().find(|saved| saved.item.parent_id == id) {
        if saved.item.name == input.name && saved.item.revision == input.revision {
            return view(&app, saved).map(Json);
        }
        return Err(Error(
            StatusCode::CONFLICT,
            "Cancel the existing queued build before replacing it".into(),
        ));
    }
    let jobs = recovery::restore(&app, &id)?;
    let parent = jobs.iter().find(|job| job.id == id).unwrap();
    if app.performance
        || parent.repository_save
        || parent.optimization
        || parent.name != input.name
        || app
            .remote
            .as_ref()
            .is_none_or(|remote| remote.identity() != parent.remote_identity)
        || recovery::latest(&app, &input.name)?.as_deref() != Some(&id)
        || stopped(&app, &id)?
        || (!parent.recover && parent.status != "completed")
    {
        return Err(Error(StatusCode::CONFLICT, "Queue requires the latest supported build for this file and remote, without failure or Stop".into()));
    }
    drop(jobs);
    if items.len() >= MAX_ITEMS {
        return Err(Error(
            StatusCode::CONFLICT,
            "Queued build limit reached; dismiss old items".into(),
        ));
    }
    let document = read(&app.root, &input.name)?;
    if document.revision != input.revision {
        return Err(Error(
            StatusCode::CONFLICT,
            "Save your current revision before queuing".into(),
        ));
    }
    if document.content.trim().is_empty() || document.content.len() > MAX_BUILD_SPEC {
        return Err(invalid("Queued specs must be nonempty and at most 120 KiB"));
    }
    let item = Item {
        parent_id: id,
        name: document.name,
        revision: document.revision,
        status: Status::Waiting,
        id: None,
        reason: None,
    };
    items.push(Saved {
        item: item.clone(),
        content: document.content,
        child_id: Uuid::new_v4().to_string(),
    });
    persist(&app, &items)?;
    Ok(Json(item))
}

pub(super) async fn delete(
    State(app): State<App>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    recovery::valid_id(&id)?;
    let _files = app.files.lock().unwrap();
    let mut items = load(&app)?;
    items.retain(|saved| saved.item.parent_id != id);
    persist(&app, &items)?;
    // Dismissing a started item never signals its child.
    Ok(Json(serde_json::json!({"ok": true})))
}

pub(super) fn stop(app: &App, id: &str) -> Result<()> {
    if app.performance {
        return Ok(());
    }
    recovery::valid_id(id)?;
    let _files = app.files.lock().unwrap();
    drop(recovery::restore(app, id)?);
    // Durable even if final success wins the remote cancellation race, or no
    // queue exists yet. Never wait for admission or a remote run gate first.
    let marker = recovery::directory(app, true)
        .and_then(|dir| recovery::atomic(&dir, &format!("stop-{id}"), b"1"));
    // Either write can preserve revocation if the other destination is broken.
    let queue = (|| {
        let mut items = load(app)?;
        if let Some(saved) = items.iter_mut().find(|saved| {
            saved.item.parent_id == id && matches!(saved.item.status, Status::Waiting)
        }) {
            saved.item.status = Status::Paused;
            saved.item.reason = Some("Parent was stopped".into());
            persist(app, &items)?;
        }
        Ok(())
    })();
    marker.and(queue)
}

// Called under the parent's run gate and admission gate. A None result means
// wait or pause, not a failed execution that should be submitted again.
pub(super) fn prepare(app: &App, id: &str) -> Result<Option<(String, String, String)>> {
    let _files = app.files.lock().unwrap();
    let mut items = load(app)?;
    let Some(saved) = items
        .iter_mut()
        .find(|saved| saved.item.parent_id == id && matches!(saved.item.status, Status::Waiting))
    else {
        return Ok(None);
    };
    let jobs = recovery::restore(app, id)?;
    let parent = jobs.iter().find(|job| job.id == id).unwrap();
    let reason = if stopped(app, id)? {
        Some("Parent was stopped")
    } else if parent.repository_save
        || parent.optimization
        || parent.name != saved.item.name
        || recovery::latest(app, &saved.item.name)?.as_deref() != Some(id)
    {
        Some("Parent is no longer the latest supported build")
    } else if app
        .remote
        .as_ref()
        .is_none_or(|remote| remote.identity() != parent.remote_identity)
    {
        Some("Remote configuration no longer matches the parent")
    } else if !parent.recover && parent.status != "completed" {
        Some("Parent did not complete successfully")
    } else {
        None
    };
    if let Some(reason) = reason {
        saved.item.status = Status::Paused;
        saved.item.reason = Some(reason.into());
        persist(app, &items)?;
        return Ok(None);
    }
    if parent.recover || parent.attached || parent.persistence_error.is_some() {
        return Ok(None);
    }
    Ok(Some((
        saved.item.name.clone(),
        saved.content.clone(),
        saved.child_id.clone(),
    )))
}

// Called under app.files immediately before registering the child. The durable
// attempt marker precedes ALL launch side effects; restart never resubmits it.
pub(super) fn claim(app: &App, parent_id: &str, child_id: &str) -> Result<()> {
    let mut items = load(app)?;
    let saved = items
        .iter_mut()
        .find(|saved| {
            saved.item.parent_id == parent_id
                && saved.child_id == child_id
                && matches!(saved.item.status, Status::Waiting)
        })
        .ok_or_else(|| {
            Error(
                StatusCode::CONFLICT,
                "Queued build was cancelled or already dispatched".into(),
            )
        })?;
    if stopped(app, parent_id)? {
        return Err(Error(StatusCode::CONFLICT, "Parent was stopped".into()));
    }
    saved.item.status = Status::Started;
    saved.item.id = Some(child_id.into());
    persist(app, &items)
}

pub(super) async fn dispatch(app: &App) -> Result<()> {
    let pending: Vec<_> = {
        let _files = app.files.lock().unwrap();
        load(app)?
            .into_iter()
            .filter(|saved| matches!(saved.item.status, Status::Waiting))
            .map(|saved| saved.item.parent_id)
            .collect()
    };
    for id in pending {
        if let Err(error) = start_run(app.clone(), RunInput::Queued(id)).await {
            // Pre-admission errors are safe to recheck. After claim, even a
            // crash or lost SSH response leaves a non-waiting durable record.
            eprintln!("Queued build check: {}", error.1);
        }
    }
    Ok(())
}

pub(super) fn spawn(app: App) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if let Err(error) = dispatch(&app).await {
                eprintln!("Queued builds: {}", error.1);
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    })
}

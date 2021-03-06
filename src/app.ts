/**
 * @license
 * Copyright Coinversable B.V. All Rights Reserved.
 *
 * Use of this source code is governed by a AGPLv3-style license that can be
 * found in the LICENSE file at https://validana.io/license
 */

import * as Cluster from "cluster";
import * as OS from "os";
import { Handler } from "./handlers/handler";
import { Log } from "./tools/log";
import { RestHandler } from "./handlers/resthandler";
import { WebsocketHandler } from "./handlers/wshandler";
import { Database } from "./database";
import { Config } from "./config";

/** An extension to the standard cluster worker to see how many times it failed to notify the master. */
class ExtendedWorker extends Cluster.Worker {
	public notNotifiedTimes: number | undefined;
}

/**
 * The app is responsible for setting up the cluster of workers and restarting them if needed.
 * Calling start will start this process.
 */
export function start(): void {

	//What if there is an exception that was not cought
	process.on("uncaughtException", (error: Error) => {
		if (error.stack === undefined) {
			error.stack = "";
		}
		//Do not accidentially capture password
		if (Config.get().VSERVER_DBPASSWORD !== undefined) {
			error.message = error.message.replace(new RegExp(Config.get().VSERVER_DBPASSWORD, "g"), "");
			error.stack = error.stack.replace(new RegExp(Config.get().VSERVER_DBPASSWORD, "g"), "");
		}
		Log.fatal("uncaughtException", error).then(() => process.exit(2));
	});
	process.on("unhandledRejection", (reason: any, _: Promise<any>) => {
		Log.fatal(`unhandledRejection: ${reason}`, new Error("unhandledRejection")).then(() => process.exit(2));
	});
	process.on("warning", (warning: Error) => {
		Log.error("Process warning", warning);
	});

	//Load the config
	try {
		Config.get();
	} catch (error) {
		Log.error(`${error.message} Exiting process.`);
		process.exit(1);
	}

	//Set log information:
	Log.options.tags!.master = Cluster.isMaster.toString();
	Log.options.tags!.nodejsVersion = process.versions.node;
	Log.Level = Config.get().VSERVER_LOGLEVEL;
	if (Config.get().VSERVER_SENTRYURL !== "") {
		try {
			Log.setReportErrors(Config.get().VSERVER_SENTRYURL);
		} catch (error) {
			Log.error(`Invalid sentry url: ${error.message} Exiting process.`);
			process.exit(1);
		}
	}

	let isShuttingDown: boolean = false;
	let isGraceful: boolean = true;

	//Check if this is the master or a worker.
	if (Cluster.isMaster) {
		setupMaster();
	} else {
		setupWorker();
	}

	/** Setup the master. */
	function setupMaster(): void {
		Log.info(`Master (pid: ${process.pid}) is running`);

		//Start the workers.
		let workers = Config.get().VSERVER_WORKERS;
		if (workers <= 0) {
			workers = Math.max(1, OS.cpus().length + workers);
		}
		for (let i = 0; i < workers; i++) {
			createWorker();
		}

		//If a worker shuts down.
		Cluster.on("exit", (worker: Cluster.Worker, code: number, _: string) => {
			if (code === 0) {
				//Should only happen if master told worker to shut down, for example when we tell the master to shut down.
				Log.info(`Worker ${worker.id} (pid: ${worker.process.pid}) exited.`);
			} else {
				Log.info(`Worker ${worker.id} (pid: ${worker.process.pid}) died with code ${code}`);
				Log.error(`Worker died with code ${code}`);
			}

			//Restart worker after a 1 second timeout.
			if (!isShuttingDown) {
				//handler notified that it wants to stay down for a while.
				if (code >= 50 && code < 60) {
					setTimeout(createWorker, 30000);
				} else {
					setTimeout(createWorker, 1000);
				}
			}
		});

		//If a worker sends a message.
		Cluster.on("message", (worker: Cluster.Worker, message: any) => {
			if (message && message.type === "report" && message.memory) {
				(worker as ExtendedWorker).notNotifiedTimes = 0;
				if (message.memory > Config.get().VSERVER_MAXMEMORY) {
					Log.warn(`Worker ${worker.id} using too much memory, restarting worker.`);
					shutdownWorker(worker.id.toString(), true);
				}
			} else {
				Log.info(`Worker ${worker.id} send an unknown message.`);
				Log.error("Worker send an unknown message.");
			}
		});

		//Check if the worker is still responding
		setInterval(() => {
			for (const id of Object.keys(Cluster.workers)) {
				const worker = Cluster.workers[id] as ExtendedWorker | undefined;
				if (worker !== undefined) {
					if (worker.notNotifiedTimes === undefined) {
						worker.notNotifiedTimes = 0;
					} else if (worker.notNotifiedTimes > 2) {
						Log.info(`Worker ${id} failed to notify for 30 seconds, restarting worker.`);
						Log.error("Worker failed to notify for 30 seconds, restarting worker.");
						shutdownWorker(id, true);
					} else if (worker.notNotifiedTimes > 0) {
						Log.warn(`Worker ${id} failed to notify.`);
					}
					worker.notNotifiedTimes++;
				}
			}
		}, 10000);

		//What to do if we receive a signal to shutdown?
		process.on("SIGINT", () => shutdownMaster(false));
		process.on("SIGTERM", () => shutdownMaster(true));
	}

	/** Shutdown the master. */
	function shutdownMaster(hardkill: boolean, code: number = 0): void {
		if (!isShuttingDown) {
			Log.info("Master shutting down...");

			isShuttingDown = true;

			//Send shutdown signal to all workers.
			isGraceful = true;
			for (const id of Object.keys(Cluster.workers)) {
				shutdownWorker(id, hardkill);
			}

			setInterval(() => {
				if (Object.keys(Cluster.workers).length === 0) {
					Log.info("Shutdown completed");
					process.exit(code === 0 && !isGraceful ? 1 : code);
				}
			}, 500);
		}
	}

	/** Setup a worker. */
	function setupWorker(): void {
		//If this process encounters an error when being created/destroyed. We do not do a graceful shutdown in this case.
		Cluster.worker.on("error", (error) => {
			Log.error("Worker encountered an error", error);

			process.exit(1);
		});

		Log.info(`Worker ${Cluster.worker.id} (pid: ${process.pid}) started`);

		//Give config info to Database before adding action handlers
		Database.get().init(Cluster.worker);

		//Handler to handle incomming connections.
		const handlers: Handler[] = [];
		if (Config.get().VSERVER_WSPORT !== 0) {
			handlers.push(new WebsocketHandler(Cluster.worker, Config.get().VSERVER_WSPORT));
		}
		if (Config.get().VSERVER_RESTPORT !== 0) {
			handlers.push(new RestHandler(Cluster.worker, Config.get().VSERVER_RESTPORT));
		}

		//If the master sends a shutdown message we do a graceful shutdown.
		Cluster.worker.on("message", (message: string) => {
			Log.info(`Worker ${process.pid} received message: ${message}`);
			if (message === "shutdown" && !isShuttingDown) {
				//handler will also end the process after it is done.
				isShuttingDown = true;
				const promises = [];
				for (const handler of handlers) {
					promises.push(handler.shutdownServer(true));
				}
				Promise.all(promises).then(() => process.exit(0)).catch();
			}
		});

		//What to do if we receive a signal to shutdown?
		process.on("SIGTERM", () => {
			Log.info(`Worker ${process.pid} received SIGTERM`);
			if (!isShuttingDown) {
				isShuttingDown = true;
				const promises = [];
				for (const handler of handlers) {
					promises.push(handler.shutdownServer(true));
				}
				Promise.all(promises).then(() => process.exit(0));
			}
		});
		process.on("SIGINT", () => {
			Log.info(`Worker ${process.pid} received SIGINT`);
			if (!isShuttingDown) {
				isShuttingDown = true;
				const promises = [];
				for (const handler of handlers) {
					promises.push(handler.shutdownServer(true));
				}
				Promise.all(promises).then(() => process.exit(0));
			}
		});
	}

	/** Create a new worker. Will retry until it succeeds. */
	function createWorker(timeout: number = 5000): void {
		try {
			Cluster.fork(Config.get());
		} catch (error) {
			Log.warn("Failed to start worker", error);
			//Increase retry time up to 5 min max.
			setTimeout(createWorker, timeout, Math.min(timeout * 1.5, 300000));
		}
	}

	/**
	 * Shutdown a worker.
	 * @param id the id of the worker to shut down.
	 * @param hardkill whether to kill the worker if it does not gracefully shutdown within 10 seconds.
	 */
	function shutdownWorker(id: string, hardkill: boolean): void {
		//Send shutdown message for a chance to do a graceful shutdown.
		if (Cluster.workers[id] !== undefined) {
			Cluster.workers[id]!.send("shutdown", undefined, (error: Error | null) => {
				//Doesn't matter if it fails, there will be a hard kill in 10 seconds.
				//(write EPIPE errors mean the worker closed the connection, properly because it already exited.)
				if (error !== null && error.message !== "write EPIPE") {
					Log.warn(`Worker ${id} shutdown failed`, error);
				}
			});
		} else {
			Log.info(`Trying to shutdown non-existing worker ${id}`);
			Log.error("Trying to shutdown non-existing worker");
		}

		//Give every handler 10 seconds to shut down before doing a hard kill.
		if (hardkill) {
			setTimeout(() => {
				if (Cluster.workers[id] !== undefined) {
					isGraceful = false;
					Log.info(`Worker ${id} not shutting down.`);
					Log.fatal("Hard killing worker, is there a contract with an infinite loop somewhere?");
					process.kill(Cluster.workers[id]!.process.pid, "SIGKILL");
				}
			}, 10000);
		}
	}
}
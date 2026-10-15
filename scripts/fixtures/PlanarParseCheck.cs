using System;
using System.IO;
using UnityEngine;
public static class PlanarParseCheck {
 static void Need(bool value,string message){if(!value)throw new Exception(message);}
 public static void Run(){
  var absent=Partsmith.PlanarParserCandidate.PartsmithGraphicsBridge.ParseDeliveryRequest("{\"schemaVersion\":1,\"rigType\":\"generic\"}");Need(absent.rigContract==null,"Absent contract synthesized");
  foreach(var raw in new[]{"{\"objectName\":\"{\\\"rigContract\\\":{}}\",\"rigType\":\"generic\"}","{\"optimization\":{\"rigContract\":{}},\"rigType\":\"generic\"}"})Need(Partsmith.PlanarParserCandidate.PartsmithGraphicsBridge.ParseDeliveryRequest(raw).rigContract==null,"Nested/string key recognized as root");
  foreach(var partial in new[]{"{}","{\"rigType\":\"generic\"}","{\"schemaVersion\":1,\"rigType\":\"humanoid\"}","null"}){bool rejected=false;try{Partsmith.PlanarParserCandidate.PartsmithGraphicsBridge.ParseDeliveryRequest("{\"rigContract\":"+partial+"}");}catch(Exception){rejected=true;}Need(rejected,"Partial/null supplied contract accepted");}
  var valid=Partsmith.PlanarParserCandidate.PartsmithGraphicsBridge.ParseDeliveryRequest("{\"rigContract\":{\"schemaVersion\":1,\"versionId\":\"rig\",\"producerVersionId\":\"producer\",\"producerTaskId\":\"task\",\"rigType\":\"generic\",\"hairBinding\":\"head\",\"requiredParts\":[],\"humanBones\":[]}}");Need(valid.rigContract.rigType=="generic","Valid explicit contract failed");
  File.WriteAllText(Path.Combine(Directory.GetParent(Application.dataPath).FullName,"PlanarEvidence/parser.json"),"{\"passed\":true,\"checks\":8,\"processAllCalled\":false}");
 }
}
